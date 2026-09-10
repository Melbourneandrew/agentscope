import { spawn } from "node:child_process";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { performance } from "node:perf_hooks";
import { dirname, isAbsolute, resolve } from "node:path";

const containmentProofMilliseconds = 5_000;
const containmentPollMilliseconds = 10;
const systemdTerminationGraceMilliseconds = 1_000;
const maximumToolOutputBytes = 64 * 1024;
const maximumManagerBytes = 16 * 1024 * 1024;
const maximumNodeBytes = 256 * 1024 * 1024;
const readlinkPath = "/usr/bin/readlink";
const sha256sumPath = "/usr/bin/sha256sum";
const statPath = "/usr/bin/stat";
const sudoPath = "/usr/bin/sudo";
const pythonPath = "/usr/bin/python3";
const systemctlPath = "/usr/bin/systemctl";
const systemdRunPath = "/usr/bin/systemd-run";
const timeoutPath = "/usr/bin/timeout";
const rootToolKillAfterMilliseconds = 250;
const rootToolJoinReserveMilliseconds = 500;
const rootToolSentinelPreparationMilliseconds = 500;
const rootToolHelperTeardownReserveMilliseconds = 750;
const systemdPreparationMilliseconds = 15_000;
const rootHelperStages = new Set([
  "startup",
  "cutoff",
  "sentinel",
  "tool-spawn",
  "client-terminal",
  "unit-admission",
  "retirement",
  "join",
]);
const rootHelperSentinelReasons = new Set([
  "child-exit",
  "start-identity",
  "inherited-group",
  "transition-timeout",
  "kill",
  "reap-join",
  "residual",
  "internal-unknown",
]);
const rootHelperJoinReasons = new Set([
  "leader-identity",
  "preclose-residual",
  "control-close",
  "reap-timeout",
  "identity-drift",
  "postreap-residual",
  "internal-unknown",
]);
const rootHelperClientTerminalReasons = new Set([
  "cutoff",
  "deadline",
  "leader-identity",
  "child-admission",
  "member-identity",
  "output-read",
  "output-bound",
  "nonzero-terminal",
  "internal-unknown",
]);
const systemdLifecyclePhases = new Set([
  "mapped-executable-pre-submit",
  "unit-admission",
  "terminal-wait",
  "unit-authoritative",
  "cgroup-observation",
  "termination",
  "retirement",
  "collection",
]);
const systemdLifecycleReasons = new Set([
  "deadline",
  "interrupted",
  "authority",
  "malformed",
  "internal",
]);
const systemdRetirementAuthorityReasons = new Set([
  "authority-load",
  "authority-identity",
  "authority-cgroup",
  "authority-hardening",
  "authority-principal",
]);
const systemdTerminalWaitAuthorityReasons = new Set([
  "unit-show",
  "unit-parse",
  "authority-load",
  "authority-identity",
  "authority-cgroup",
  "authority-hardening",
  "authority-principal",
]);
const systemdRetirementDiagnosticReasons = new Set([
  "cgroup-retained",
  "cgroup-path",
  "unit-show",
  "unit-command",
  "descriptor-close",
]);
const systemdCollectionDiagnosticReasons = new Set([
  "unit-show",
  "unit-facts",
  "load-state",
  "cgroup-absence",
]);
const systemdToolFailures = new WeakMap();
const rootToolOperations = new Map([
  ["synthetic-descendant", pythonPath],
  ["synthetic-cleanup-failure", pythonPath],
  ["synthetic-delayed-sentinel", pythonPath],
  ["synthetic-setpgid-eacces", pythonPath],
  ["synthetic-setpgid-non-eacces", pythonPath],
  ["synthetic-sentinel-cleanup-failure", pythonPath],
  ["synthetic-join-failure", pythonPath],
  ["synthetic-join-cleanup-failure", pythonPath],
  ["synthetic-join-identity-drift", pythonPath],
  ["synthetic-client-cutoff", pythonPath],
  ["synthetic-client-cutoff-cleanup-failure", pythonPath],
  ["synthetic-client-deadline", pythonPath],
  ["synthetic-client-leader-identity", pythonPath],
  ["synthetic-client-child-admission", pythonPath],
  ["synthetic-client-member-identity", pythonPath],
  ["synthetic-client-output-read", pythonPath],
  ["synthetic-client-output-bound", pythonPath],
  ["synthetic-client-nonzero", pythonPath],
  ["synthetic-client-internal", pythonPath],
  ["pid1-readlink-1", readlinkPath],
  ["pid1-stat", statPath],
  ["pid1-digest", sha256sumPath],
  ["pid1-readlink-2", readlinkPath],
  ["systemd-submit", systemdRunPath],
  ["unit-admission", systemctlPath],
  ["unit-monitor", systemctlPath],
  ["unit-authoritative", systemctlPath],
  ["unit-collection", systemctlPath],
  ["unit-retirement", systemctlPath],
  ["unit-kill-term", systemctlPath],
  ["unit-kill-kill", systemctlPath],
  ["unit-stop", systemctlPath],
  ["unit-reset", systemctlPath],
]);
const pythonCapabilityReceipt = "agentscope-python-helper-v1\n";
const pythonCapabilitySource = String.raw`
import base64,errno,json,os,signal,subprocess,sys,time
required=(base64.urlsafe_b64decode,base64.urlsafe_b64encode,json.dumps,json.loads,os.write,os.killpg,os.listdir,os.pipe2,os.fork,os.close,os.setpgid,os.read,os._exit,os.kill,os.waitpid,os.set_blocking,signal.signal,subprocess.Popen,time.clock_gettime_ns,time.sleep)
constants=(errno.EACCES,errno.EPERM,os.O_CLOEXEC,os.WNOHANG,signal.SIGTERM,signal.SIGKILL,signal.SIG_IGN,subprocess.DEVNULL,subprocess.PIPE,time.CLOCK_BOOTTIME,sys.executable)
if len(required)!=20 or not all(callable(value) for value in required) or len(constants)!=11 or errno.EACCES!=13 or errno.EPERM!=1: raise SystemExit(71)
os.write(1,b"agentscope-python-helper-v1\n")
`;
const rootHelperSource = String.raw`
import base64,errno,hashlib,hmac,json,os,signal,subprocess,sys,time
MAX=65536
SENTINEL_PREPARATION=500000000
TEARDOWN_RESERVE=750000000
TEST_CODE='import signal,subprocess,sys,time; subprocess.Popen([sys.executable,"-I","-S","-c","import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(30)","agentscope-root-helper-descendant"],stdout=sys.stdout,stderr=subprocess.DEVNULL); sys.exit(0)'
TEST_ARGS=["-I","-S","-c",TEST_CODE]
TEST_FAIL_CODE='import sys; sys.exit(17)'
TEST_FAIL_ARGS=["-I","-S","-c",TEST_FAIL_CODE]
TEST_DELAY_CODE='import sys; sys.exit(0)'
TEST_DELAY_ARGS=["-I","-S","-c",TEST_DELAY_CODE]
TEST_SLEEP_CODE='import time; time.sleep(5)'
TEST_SLEEP_ARGS=["-I","-S","-c",TEST_SLEEP_CODE]
TEST_OUTPUT_CODE='import os; os.write(1,b"x"*65537)'
TEST_OUTPUT_ARGS=["-I","-S","-c",TEST_OUTPUT_CODE]
OPERATIONS={"synthetic-descendant":"/usr/bin/python3","synthetic-cleanup-failure":"/usr/bin/python3","synthetic-delayed-sentinel":"/usr/bin/python3","synthetic-setpgid-eacces":"/usr/bin/python3","synthetic-setpgid-non-eacces":"/usr/bin/python3","synthetic-sentinel-cleanup-failure":"/usr/bin/python3","synthetic-join-failure":"/usr/bin/python3","synthetic-join-cleanup-failure":"/usr/bin/python3","synthetic-join-identity-drift":"/usr/bin/python3","synthetic-client-cutoff":"/usr/bin/python3","synthetic-client-cutoff-cleanup-failure":"/usr/bin/python3","synthetic-client-deadline":"/usr/bin/python3","synthetic-client-leader-identity":"/usr/bin/python3","synthetic-client-child-admission":"/usr/bin/python3","synthetic-client-member-identity":"/usr/bin/python3","synthetic-client-output-read":"/usr/bin/python3","synthetic-client-output-bound":"/usr/bin/python3","synthetic-client-nonzero":"/usr/bin/python3","synthetic-client-internal":"/usr/bin/python3","pid1-readlink-1":"/usr/bin/readlink","pid1-stat":"/usr/bin/stat","pid1-digest":"/usr/bin/sha256sum","pid1-readlink-2":"/usr/bin/readlink","systemd-submit":"/usr/bin/systemd-run","unit-admission":"/usr/bin/systemctl","unit-monitor":"/usr/bin/systemctl","unit-authoritative":"/usr/bin/systemctl","unit-collection":"/usr/bin/systemctl","unit-retirement":"/usr/bin/systemctl","unit-kill-term":"/usr/bin/systemctl","unit-kill-kill":"/usr/bin/systemctl","unit-stop":"/usr/bin/systemctl","unit-reset":"/usr/bin/systemctl"}
STAGES={"startup","cutoff","sentinel","tool-spawn","client-terminal","unit-admission","retirement","join"}
SENTINEL_REASONS={"child-exit","start-identity","inherited-group","transition-timeout","kill","reap-join","residual","internal-unknown"}
JOIN_REASONS={"leader-identity","preclose-residual","control-close","reap-timeout","identity-drift","postreap-residual","internal-unknown"}
CLIENT_TERMINAL_REASONS={"cutoff","deadline","leader-identity","child-admission","member-identity","output-read","output-bound","nonzero-terminal","internal-unknown"}
STAGE="startup"
REASON=""
JOIN_CALLS=0
class CleanupUncertain(Exception): pass
def now(): return time.clock_gettime_ns(time.CLOCK_BOOTTIME)
def emit(status,output=b""):
 encoded=base64.urlsafe_b64encode(output).decode("ascii").rstrip("=")
 reason=REASON if (STAGE=="sentinel" and REASON in SENTINEL_REASONS) or (STAGE=="join" and REASON in JOIN_REASONS) or (STAGE=="client-terminal" and REASON in CLIENT_TERMINAL_REASONS) else ""
 identity={"cutoff":str(CUTOFF),"deadline":str(DEADLINE),"operation":OPERATION,"output":encoded,"reason":reason,"stage":STAGE,"status":status,"unit":unit}
 mac=hmac.new(bytes.fromhex(KEY),json.dumps(identity,sort_keys=True,separators=(",",":")).encode("ascii"),hashlib.sha256).hexdigest()
 data=json.dumps({"mac":mac,"output":encoded,"reason":reason,"stage":STAGE,"status":status},sort_keys=True,separators=(",",":"))
 os.write(1,data.encode("ascii"))
def group_present(pid):
 try: os.killpg(pid,0); return True
 except ProcessLookupError: return False
def parse_process_fields(data,pid):
 if not isinstance(data,bytes) or len(data)<4 or len(data)>4096 or not data.endswith(b"\n"):
  raise RuntimeError("identity")
 record=data[:-1]
 if not record or b"\n" in record or b"\r" in record or b"\x00" in record:
  raise RuntimeError("identity")
 prefix=(str(pid)+" (").encode("ascii")
 if not record.startswith(prefix): raise RuntimeError("identity")
 end=record.rfind(b") ")
 if end<=len(prefix): raise RuntimeError("identity")
 fields=record[end+2:].split()
 if len(fields)<20 or len(fields[0])!=1 or not fields[0].isascii(): raise RuntimeError("identity")
 if not fields[1].isascii() or not fields[1].isdigit(): raise RuntimeError("identity")
 if not fields[2].isascii() or not fields[2].isdigit(): raise RuntimeError("identity")
 if not fields[19].isascii() or not fields[19].isdigit() or int(fields[19])<1: raise RuntimeError("identity")
 return fields
def parse_process_identity(data,pid):
 fields=parse_process_fields(data,pid)
 if int(fields[2])<1: raise RuntimeError("identity")
 return (fields[19],int(fields[2]))
def process_identity(pid):
 try: data=open("/proc/%d/stat"%pid,"rb").read(4097)
 except FileNotFoundError: return None
 return parse_process_identity(data,pid)
def parse_process_record(data,pid):
 identity=parse_process_identity(data,pid)
 fields=parse_process_fields(data,pid)
 return (identity[0],identity[1],int(fields[1]))
def process_record(pid):
 try: data=open("/proc/%d/stat"%pid,"rb").read(4097)
 except FileNotFoundError: return None
 return parse_process_record(data,pid)
def process_record_for_group(pid,group,expected_members=None):
 try: data=open("/proc/%d/stat"%pid,"rb").read(4097)
 except FileNotFoundError: return None
 fields=parse_process_fields(data,pid)
 observed_group=int(fields[2])
 record=(fields[19],observed_group,int(fields[1]))
 if expected_members is not None and pid in expected_members and record!=expected_members[pid]:
  raise RuntimeError("identity")
 if observed_group==0 or observed_group!=group: return None
 return record
def group_records(group,expected_members=None):
 if not isinstance(group,int) or group<1: raise RuntimeError("inventory")
 if expected_members is not None and not isinstance(expected_members,dict): raise RuntimeError("inventory")
 if expected_members is not None:
  for pid,record in expected_members.items():
   if not isinstance(pid,int) or pid<1 or not isinstance(record,tuple) or len(record)!=3: raise RuntimeError("inventory")
 entries=os.listdir("/proc")
 if len(entries)>65536: raise RuntimeError("inventory")
 records={}
 seen=set()
 for entry in entries:
  if entry.isdigit():
   pid=int(entry)
   if pid in seen: raise RuntimeError("inventory")
   seen.add(pid)
   observed=process_record_for_group(pid,group,expected_members)
   if observed is not None: records[pid]=observed
 if expected_members is not None:
  for pid,expected in expected_members.items():
   if pid in seen: continue
   observed=process_record(pid)
   if observed is None: continue
   if observed!=expected: raise RuntimeError("identity")
   records[pid]=observed
 return records
def group_members(group):
 return sorted(group_records(group))
def admit_group_members(group,expected_members):
 records=group_records(group,expected_members)
 pending=dict(records)
 while pending:
  progressed=False
  for pid,record in list(pending.items()):
   expected=expected_members.get(pid)
   if expected is not None:
    if record!=expected: raise RuntimeError("identity")
    del pending[pid]; progressed=True; continue
   parent=expected_members.get(record[2])
   parent_record=records.get(record[2])
   if parent is not None and parent_record is not None and parent_record==parent:
    expected_members[pid]=record
    del pending[pid]; progressed=True
  if not progressed: raise RuntimeError("residual")
 return records
def create_group():
 global STAGE,REASON
 STAGE="sentinel"
 REASON="internal-unknown"
 sentinel_started=now()
 inherited_group=os.getpgrp()
 control_read,control_write=os.pipe2(os.O_CLOEXEC)
 leader=os.fork()
 if leader==0:
  try:
   os.close(control_write)
   if OPERATION=="synthetic-delayed-sentinel": time.sleep(0.35)
   if OPERATION=="synthetic-sentinel-cleanup-failure": time.sleep(0.6)
   os.setpgid(0,0); signal.signal(signal.SIGTERM,signal.SIG_IGN)
   if os.read(control_read,1)!=b"\x00": raise RuntimeError("control-revoke")
   while os.read(control_read,1): pass
  finally: os._exit(0)
 os.close(control_read)
 boundary=min(sentinel_started+SENTINEL_PREPARATION,DEADLINE-TEARDOWN_RESERVE)
 expected=None
 expected_start=None
 try:
  if now()>=boundary:
   REASON="transition-timeout"; raise RuntimeError("sentinel")
  while now()<boundary and expected_start is None:
   observed=process_identity(leader)
   if observed is None:
    waited=os.waitpid(leader,os.WNOHANG)
    if waited[0]==leader:
     REASON="child-exit"; raise RuntimeError("sentinel")
    time.sleep(0.001); continue
   expected_start=observed[0]
  if expected_start is None:
   REASON="transition-timeout"; raise RuntimeError("sentinel")
  if OPERATION=="synthetic-delayed-sentinel": time.sleep(0.35)
  if OPERATION=="synthetic-sentinel-cleanup-failure": time.sleep(0.6)
  if now()>=boundary:
   REASON="transition-timeout"; raise RuntimeError("sentinel")
  try:
   if OPERATION=="synthetic-setpgid-eacces":
    while now()<boundary and process_identity(leader)!=(expected_start,leader): time.sleep(0.001)
    raise OSError(errno.EACCES,"synthetic")
   if OPERATION=="synthetic-setpgid-non-eacces": raise OSError(errno.EPERM,"synthetic")
   os.setpgid(leader,leader)
  except OSError as error:
   observed=process_identity(leader)
   if error.errno!=errno.EACCES or observed!=(expected_start,leader):
    REASON="child-exit" if observed is None else "start-identity" if observed[0]!=expected_start else "inherited-group"
    raise RuntimeError("sentinel")
  while now()<boundary:
   observed=process_identity(leader)
   if observed is None:
    REASON="child-exit"; raise RuntimeError("sentinel")
   if observed[0]!=expected_start:
    REASON="start-identity"; raise RuntimeError("sentinel")
   if observed[1]==leader:
    expected=(expected_start,leader); break
   if observed[1]!=inherited_group:
    REASON="inherited-group"; raise RuntimeError("sentinel")
   time.sleep(0.001)
  if expected is None:
   REASON="transition-timeout"; raise RuntimeError("sentinel")
 except Exception:
  failure_reason=REASON
  try: os.close(control_write)
  except OSError: pass
  observed=process_identity(leader)
  if expected_start is not None and observed is not None and observed[0]==expected_start:
   try: os.kill(leader,signal.SIGKILL)
   except ProcessLookupError: pass
   except OSError:
    REASON=failure_reason; raise CleanupUncertain()
  reaped=False
  while now()<DEADLINE:
   waited=os.waitpid(leader,os.WNOHANG)
   if waited[0]==leader: reaped=True; break
   time.sleep(0.005)
  if not reaped:
   REASON=failure_reason; raise CleanupUncertain()
  if group_present(leader):
   REASON=failure_reason; raise CleanupUncertain()
  if OPERATION=="synthetic-sentinel-cleanup-failure":
   REASON=failure_reason; raise CleanupUncertain()
  REASON=failure_reason
  raise RuntimeError("sentinel")
 REASON=""
 return leader,expected,control_write
def close_group(leader,expected,control,expected_members):
 global STAGE,REASON,JOIN_CALLS
 JOIN_CALLS+=1
 STAGE="join"
 REASON="internal-unknown"
 REASON="leader-identity"
 if process_identity(leader)!=expected: raise RuntimeError("identity")
 REASON="preclose-residual"
 if OPERATION in {"synthetic-join-failure","synthetic-join-cleanup-failure"} and JOIN_CALLS==1:
  raise RuntimeError("synthetic-join")
 records=admit_group_members(leader,expected_members)
 REASON="identity-drift"
 observed_before_revoke=None if OPERATION=="synthetic-join-identity-drift" else process_identity(leader)
 if observed_before_revoke!=expected: raise RuntimeError("identity")
 REASON="control-close"
 if os.write(control,b"\x00")!=1: raise RuntimeError("control-revoke")
 REASON="preclose-residual"
 settle_boundary=DEADLINE-750000000
 while any(pid!=leader for pid in records):
  if now()>=settle_boundary: raise RuntimeError("residual")
  time.sleep(0.005)
  records=admit_group_members(leader,expected_members)
  leader_record=records.get(leader)
  if leader_record is None or leader_record[:2]!=expected:
   REASON="identity-drift"; raise RuntimeError("identity")
 REASON="control-close"
 try: os.close(control)
 except OSError: raise RuntimeError("control-close")
 leader_reaped=False
 REASON="reap-timeout"
 while now()<DEADLINE:
  records=group_records(leader,expected_members)
  for pid,record in records.items():
   member=expected_members.get(pid)
   if member is None or record!=member:
    REASON="identity-drift"; raise RuntimeError("identity")
  if not leader_reaped:
   observed=process_identity(leader)
   if observed is None:
    waited=os.waitpid(leader,os.WNOHANG)
    if waited[0]==leader: leader_reaped=True
   elif observed!=expected:
    REASON="identity-drift"; raise RuntimeError("identity")
   else:
    waited=os.waitpid(leader,os.WNOHANG)
    if waited[0]==leader: leader_reaped=True
  if leader_reaped and not records: break
  REASON="reap-timeout"
  time.sleep(0.005)
 if not leader_reaped: raise RuntimeError("join")
 REASON="postreap-residual"
 if group_present(leader): raise RuntimeError("residual")
 REASON=""
def terminate(child,leader,expected,control):
 global STAGE
 STAGE="retirement"
 child.poll()
 observed=process_identity(leader)
 if observed is None: raise RuntimeError("identity")
 if observed!=expected: raise RuntimeError("identity")
 try: os.killpg(leader,signal.SIGTERM)
 except ProcessLookupError: pass
 grace=min(DEADLINE,now()+250000000)
 while child.poll() is None and now()<grace: time.sleep(0.005)
 if child.poll() is None or group_present(leader):
  if process_identity(leader)!=expected: raise RuntimeError("identity")
  try: os.killpg(leader,signal.SIGKILL)
  except ProcessLookupError: pass
 leader_reaped=False
 while group_present(leader) and now()<DEADLINE:
  child.poll()
  if not leader_reaped:
   waited=os.waitpid(leader,os.WNOHANG)
   leader_reaped=waited[0]==leader
  time.sleep(0.005)
 child.poll()
 try: os.close(control)
 except OSError: pass
 if not leader_reaped:
  waited=os.waitpid(leader,os.WNOHANG)
  leader_reaped=waited[0]==leader
 if not leader_reaped or group_present(leader) or child.returncode is None: raise RuntimeError("join")
def run(argv,cutoff,operation_stage):
 global STAGE,REASON
 STAGE="cutoff"
 if now()>=cutoff: raise RuntimeError("cutoff")
 leader,expected,control=create_group()
 child=None
 output=bytearray()
 try:
  STAGE="cutoff"
  REASON=""
  if now()>=cutoff or now()>=DEADLINE: raise RuntimeError("cutoff")
  if process_identity(leader)!=expected: raise RuntimeError("identity")
  STAGE="tool-spawn"
  child=subprocess.Popen(argv,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env={"LANG":"C.UTF-8","PATH":"/usr/bin:/bin"},process_group=leader,close_fds=True)
  STAGE=operation_stage
  REASON="child-admission" if operation_stage=="client-terminal" else ""
  child_record=None if OPERATION=="synthetic-client-child-admission" else process_record(child.pid)
  if child_record is None or child_record[1]!=leader or child_record[2]!=os.getpid(): raise RuntimeError("identity")
  leader_record=process_record(leader)
  if leader_record is None or leader_record[:2]!=expected or leader_record[2]!=os.getpid(): raise RuntimeError("identity")
  expected_members={leader:leader_record,child.pid:child_record}
  if OPERATION=="synthetic-client-member-identity": expected_members[child.pid]=("0",child_record[1],child_record[2])
  STAGE=operation_stage
  REASON="leader-identity" if operation_stage=="client-terminal" else ""
  observed_leader=None if OPERATION=="synthetic-client-leader-identity" else process_identity(leader)
  if observed_leader!=expected: raise RuntimeError("identity")
  if OPERATION=="synthetic-client-internal":
   REASON="internal-unknown"; raise RuntimeError("synthetic-client")
  REASON="output-read" if operation_stage=="client-terminal" else ""
  os.set_blocking(child.stdout.fileno(),False)
  if OPERATION=="synthetic-client-output-read": child.stdout.close()
  while child.poll() is None:
   REASON="member-identity" if operation_stage=="client-terminal" else ""
   admit_group_members(leader,expected_members)
   if now()>=cutoff:
    REASON="cutoff" if operation_stage=="client-terminal" else ""
    raise RuntimeError("cutoff")
   try:
    REASON="output-read" if operation_stage=="client-terminal" else ""
    part=os.read(child.stdout.fileno(),4096)
    if part:
     output.extend(part)
     if len(output)>MAX:
      REASON="output-bound" if operation_stage=="client-terminal" else ""
      raise RuntimeError("oversize")
   except BlockingIOError: pass
   if child.poll() is None:
    if now()>=DEADLINE:
     REASON="deadline" if operation_stage=="client-terminal" else ""
     raise RuntimeError("deadline")
    time.sleep(0.005)
  while True:
   REASON="output-read" if operation_stage=="client-terminal" else ""
   part=os.read(child.stdout.fileno(),4096)
   if not part: break
   output.extend(part)
   if len(output)>MAX:
    REASON="output-bound" if operation_stage=="client-terminal" else ""
    raise RuntimeError("oversize")
  STAGE=operation_stage
  if now()>=DEADLINE:
   REASON="deadline" if operation_stage=="client-terminal" else ""
   raise RuntimeError("terminal")
  if child.returncode!=0 and not (OPERATION=="unit-collection" and child.returncode==4):
   REASON="nonzero-terminal" if operation_stage=="client-terminal" else ""
   raise RuntimeError("terminal")
  close_group(leader,expected,control,expected_members)
  STAGE=operation_stage
  return bytes(output)
 except Exception as original:
  failed_stage=STAGE
  failed_reason=REASON
  try:
   if child is None:
    leader_record=process_record(leader)
    if leader_record is None or leader_record[:2]!=expected or leader_record[2]!=os.getpid(): raise RuntimeError("identity")
    close_group(leader,expected,control,{leader:leader_record})
   else:
    terminate(child,leader,expected,control)
    if OPERATION in {"synthetic-cleanup-failure","synthetic-client-cutoff-cleanup-failure"}: raise RuntimeError("synthetic-cleanup")
   if OPERATION=="synthetic-join-cleanup-failure": raise RuntimeError("synthetic-cleanup")
  except Exception:
   raise CleanupUncertain() from None
  finally:
   STAGE=failed_stage
   REASON=failed_reason
  raise original
 finally:
  if child is not None and child.stdout is not None: child.stdout.close()
def reconcile(unit):
 global STAGE
 STAGE="retirement"
 for args in (["kill","--kill-whom=all","--signal=SIGKILL",unit],["stop",unit],["reset-failed",unit]):
  try: run(["/usr/bin/systemctl",*args],DEADLINE-100000000,"retirement")
  except Exception: pass
 try:
  out=run(["/usr/bin/systemctl","show","--no-pager","--property=LoadState",unit],DEADLINE-50000000,"retirement")
  return out==b"LoadState=not-found\n"
 except Exception: return False
try:
 if len(sys.argv)!=8: raise RuntimeError("argv")
 DEADLINE=int(sys.argv[1]); CUTOFF=int(sys.argv[2]); OPERATION=sys.argv[3]
 tool=sys.argv[4]; raw=sys.argv[5]; unit=sys.argv[6]; KEY=sys.argv[7]
 if OPERATION not in OPERATIONS or tool!=OPERATIONS[OPERATION] or not hmac.compare_digest(KEY.lower(),KEY) or len(KEY)!=64 or any(c not in "0123456789abcdef" for c in KEY) or now()>=CUTOFF or DEADLINE-now()<=SENTINEL_PREPARATION+TEARDOWN_RESERVE or len(raw)>131072: raise RuntimeError("authority")
 args=json.loads(base64.urlsafe_b64decode(raw+"="*((4-len(raw)%4)%4)))
 if not isinstance(args,list) or len(args)>256 or any(not isinstance(value,str) or len(value)>4096 or "\x00" in value for value in args): raise RuntimeError("arguments")
 if tool=="/usr/bin/python3" and (os.geteuid()==0 or (OPERATION=="synthetic-descendant" and args!=TEST_ARGS) or (OPERATION in {"synthetic-cleanup-failure","synthetic-client-nonzero"} and args!=TEST_FAIL_ARGS) or (OPERATION in {"synthetic-client-cutoff","synthetic-client-cutoff-cleanup-failure","synthetic-client-deadline","synthetic-client-output-read","synthetic-client-member-identity"} and args!=TEST_SLEEP_ARGS) or (OPERATION=="synthetic-client-output-bound" and args!=TEST_OUTPUT_ARGS) or (OPERATION in {"synthetic-delayed-sentinel","synthetic-setpgid-eacces","synthetic-setpgid-non-eacces","synthetic-sentinel-cleanup-failure","synthetic-join-failure","synthetic-join-cleanup-failure","synthetic-join-identity-drift","synthetic-client-leader-identity","synthetic-client-child-admission","synthetic-client-internal"} and args!=TEST_DELAY_ARGS)): raise RuntimeError("test-authority")
 if tool=="/usr/bin/systemd-run":
  if not unit or ("--unit="+unit) not in args: raise RuntimeError("unit")
 elif tool=="/usr/bin/systemctl":
  if not unit or not args or args[-1]!=unit: raise RuntimeError("unit")
 else:
  if unit: raise RuntimeError("unit")
 operation_stage="unit-admission" if OPERATION=="unit-admission" else "retirement" if OPERATION in {"unit-retirement","unit-kill-term","unit-kill-kill","unit-stop","unit-reset"} else "client-terminal"
 output=run([tool,*args],CUTOFF,operation_stage)
 emit("ok",output)
except Exception as original:
 failed_stage=STAGE
 failed_reason=REASON
 uncertain=isinstance(original,CleanupUncertain)
 if "tool" in globals() and tool=="/usr/bin/systemd-run" and "unit" in globals() and unit:
  if not reconcile(unit): uncertain=True
 STAGE=failed_stage
 REASON=failed_reason
 emit("uncertain" if uncertain else "error"); sys.exit(1)
`;
const cgroupRoot = "/sys/fs/cgroup";
const systemdPath = "/usr/lib/systemd/systemd";
const systemdInaccessiblePaths =
  "/run/dbus/system_bus_socket /run/systemd/private /run/user /var/run/dbus/system_bus_socket";
const forbiddenLifecycleEnvironment = new Set([
  "ACTIONS_RESULTS_URL",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_RUNTIME_URL",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
]);
const systemdPreparations = new WeakMap();

const parseNumericSystemdExitStatus = (facts) => {
  if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(facts.ExecMainStatus ?? ""))
    return undefined;
  const code = Number(facts.ExecMainStatus);
  return facts.ExecMainCode === "1" && Number.isSafeInteger(code) && code <= 255
    ? code
    : undefined;
};

export const parseSystemdTerminalExit = (facts) => {
  const code = parseNumericSystemdExitStatus(facts);
  if (code === undefined) return undefined;
  if (
    code === 0 &&
    facts.ActiveState === "active" &&
    facts.SubState === "exited" &&
    facts.Result === "success"
  )
    return code;
  if (
    code > 0 &&
    facts.ActiveState === "failed" &&
    facts.SubState === "failed" &&
    facts.Result === "exit-code"
  )
    return code;
  return undefined;
};

export const parseSystemdMainExitStatus = (facts) => {
  const terminal = parseSystemdTerminalExit(facts);
  if (terminal !== undefined) return terminal;
  const code = parseNumericSystemdExitStatus(facts);
  if (
    code !== undefined &&
    facts.Result === (code === 0 ? "success" : "exit-code") &&
    ((facts.ActiveState === "active" && facts.SubState === "running") ||
      (facts.ActiveState === "deactivating" &&
        facts.SubState === "stop-sigterm"))
  )
    return code;
  return undefined;
};

export const systemdMainProcessIsTerminal = (facts) =>
  parseSystemdMainExitStatus(facts) !== undefined ||
  facts.ActiveState === "failed";

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const signalGroup = (processGroup, signal) => {
  try {
    if (process.platform === "win32") process.kill(processGroup, signal);
    else process.kill(-processGroup, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
};

const groupIsAbsent = (processGroup) => {
  try {
    if (process.platform === "win32") process.kill(processGroup, 0);
    else process.kill(-processGroup, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    if (error?.code === "EPERM") return false;
    throw error;
  }
};

const proveGroupAbsent = async (processGroup) => {
  const deadline = performance.now() + containmentProofMilliseconds;
  while (performance.now() < deadline) {
    if (groupIsAbsent(processGroup)) return true;
    await delay(containmentPollMilliseconds);
  }
  return groupIsAbsent(processGroup);
};

const runProcessGroupSupervised = async ({
  arguments_: arguments_ = [],
  environment,
  executable,
  maximumMilliseconds,
  stdio = "inherit",
}) => {
  const child = spawn(executable, arguments_, {
    detached: process.platform !== "win32",
    env: environment,
    stdio,
  });
  if (!Number.isSafeInteger(child.pid) || child.pid < 1)
    throw new Error("integration.controller.spawn");
  const processGroup = child.pid;
  let forcedTimer;
  let terminating = false;
  const terminate = () => {
    if (terminating) return;
    terminating = true;
    signalGroup(processGroup, "SIGTERM");
    forcedTimer = setTimeout(() => {
      signalGroup(processGroup, "SIGKILL");
    }, containmentProofMilliseconds);
  };
  const deadlineTimer = setTimeout(terminate, maximumMilliseconds);
  const forwardSignal = () => {
    terminate();
  };
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);
  try {
    const result = await new Promise((resolveResult, rejectResult) => {
      child.once("error", rejectResult);
      child.once("close", (code, signal) => {
        resolveResult({ code, signal });
      });
    });
    clearTimeout(deadlineTimer);
    if (forcedTimer !== undefined) clearTimeout(forcedTimer);
    const residualWorkObserved = signalGroup(processGroup, "SIGKILL");
    const contained = await proveGroupAbsent(processGroup);
    return { ...result, contained, residualWorkObserved };
  } finally {
    clearTimeout(deadlineTimer);
    if (forcedTimer !== undefined) clearTimeout(forcedTimer);
    process.removeListener("SIGINT", forwardSignal);
    process.removeListener("SIGTERM", forwardSignal);
  }
};

const failSystemd = () => {
  throw new Error("integration.controller.systemd-containment");
};

const failSystemdTool = (stage, reason) => {
  const predicate =
    stage === "sentinel" || stage === "join" || stage === "client-terminal"
      ? `${stage}:${reason}`
      : stage;
  const error = new Error(`integration.controller.systemd-tool:${predicate}`);
  systemdToolFailures.set(error, Object.freeze({ predicate }));
  throw error;
};

const failSystemdLifecycle = (state, phase, reason) => {
  if (
    !systemdLifecyclePhases.has(phase) ||
    !(
      systemdLifecycleReasons.has(reason) ||
      (phase === "retirement" &&
        (systemdRetirementAuthorityReasons.has(reason) ||
          systemdRetirementDiagnosticReasons.has(reason))) ||
      (phase === "terminal-wait" &&
        systemdTerminalWaitAuthorityReasons.has(reason)) ||
      (phase === "collection" && systemdCollectionDiagnosticReasons.has(reason))
    ) ||
    typeof state.authority?.unit !== "string" ||
    !Number.isFinite(state.deadline) ||
    !Number.isFinite(state.executionDeadline)
  )
    failSystemd();
  const predicate = `lifecycle:${phase}:${reason}`;
  const error = new Error(`integration.controller.systemd-tool:${predicate}`);
  systemdToolFailures.set(
    error,
    Object.freeze({
      deadline: state.deadline,
      executionDeadline: state.executionDeadline,
      operation: phase,
      predicate,
      unit: state.authority.unit,
    }),
  );
  throw error;
};

export const validSystemdLifecyclePredicate = (predicate) => {
  if (typeof predicate !== "string") return false;
  const match = /^lifecycle:([^:]+):([^:]+)$/u.exec(predicate);
  return (
    match !== null &&
    systemdLifecyclePhases.has(match[1]) &&
    (systemdLifecycleReasons.has(match[2]) ||
      (match[1] === "retirement" &&
        (systemdRetirementAuthorityReasons.has(match[2]) ||
          systemdRetirementDiagnosticReasons.has(match[2]))) ||
      (match[1] === "terminal-wait" &&
        systemdTerminalWaitAuthorityReasons.has(match[2])) ||
      (match[1] === "collection" &&
        systemdCollectionDiagnosticReasons.has(match[2])))
  );
};

export const systemdToolFailureStage = (error) =>
  error !== null && typeof error === "object"
    ? systemdToolFailures.get(error)?.predicate
    : undefined;

const rootToolMacInput = ({
  cutoff,
  deadline,
  operation,
  output,
  reason,
  stage,
  status,
  unit,
}) =>
  JSON.stringify({
    cutoff,
    deadline,
    operation,
    output,
    reason,
    stage,
    status,
    unit,
  });

const validRootHelperReason = (stage, reason, status) =>
  typeof reason === "string" &&
  (status === "ok"
    ? reason === ""
    : stage === "sentinel"
      ? rootHelperSentinelReasons.has(reason)
      : stage === "join"
        ? rootHelperJoinReasons.has(reason)
        : stage === "client-terminal"
          ? rootHelperClientTerminalReasons.has(reason)
          : reason === "");

const validRootToolReceiptShape = (parsed, receipt) =>
  parsed !== null &&
  typeof parsed === "object" &&
  !Array.isArray(parsed) &&
  Object.keys(parsed).sort().join(",") === "mac,output,reason,stage,status" &&
  rootHelperStages.has(parsed.stage) &&
  validRootHelperReason(parsed.stage, parsed.reason, parsed.status) &&
  !(
    (parsed.stage === "sentinel" || parsed.stage === "join") &&
    (parsed.status === "ok" || parsed.output !== "")
  ) &&
  !(
    parsed.stage === "client-terminal" &&
    parsed.status !== "ok" &&
    parsed.output !== ""
  ) &&
  ["error", "ok", "uncertain"].includes(parsed.status) &&
  typeof parsed.output === "string" &&
  /^[A-Za-z0-9_-]*$/u.test(parsed.output) &&
  typeof parsed.mac === "string" &&
  /^[0-9a-f]{64}$/u.test(parsed.mac) &&
  JSON.stringify(parsed) === receipt;

export const validateRootToolReceipt = ({ identity, key, receipt }) => {
  if (
    identity === null ||
    typeof identity !== "object" ||
    typeof identity.operation !== "string" ||
    !rootToolOperations.has(identity.operation) ||
    typeof identity.deadline !== "string" ||
    !/^[1-9][0-9]*$/u.test(identity.deadline) ||
    typeof identity.cutoff !== "string" ||
    !/^[1-9][0-9]*$/u.test(identity.cutoff) ||
    typeof identity.unit !== "string" ||
    typeof key !== "string" ||
    !/^[0-9a-f]{64}$/u.test(key) ||
    typeof receipt !== "string" ||
    Buffer.byteLength(receipt) > maximumToolOutputBytes
  )
    return undefined;
  let parsed;
  try {
    parsed = JSON.parse(receipt);
  } catch {
    return undefined;
  }
  if (!validRootToolReceiptShape(parsed, receipt)) return undefined;
  const output = Buffer.from(parsed.output, "base64url");
  if (output.toString("base64url") !== parsed.output) return undefined;
  const expected = createHmac("sha256", Buffer.from(key, "hex"))
    .update(
      rootToolMacInput({
        cutoff: identity.cutoff,
        deadline: identity.deadline,
        operation: identity.operation,
        output: parsed.output,
        reason: parsed.reason,
        stage: parsed.stage,
        status: parsed.status,
        unit: identity.unit,
      }),
    )
    .digest();
  const observed = Buffer.from(parsed.mac, "hex");
  if (
    observed.length !== expected.length ||
    !timingSafeEqual(observed, expected)
  )
    return undefined;
  return Object.freeze({
    output: output.toString("utf8"),
    reason: parsed.reason,
    stage: parsed.stage,
    status: parsed.status,
  });
};

const readBounded = (path, maximumBytes) => {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = fstatSync(descriptor);
    if (!status.isFile() || status.size > maximumBytes) failSystemd();
    const content = Buffer.alloc(maximumBytes + 1);
    let size = 0;
    while (size < content.length) {
      const count = readSync(
        descriptor,
        content,
        size,
        content.length - size,
        null,
      );
      if (count === 0) break;
      size += count;
    }
    if (size > maximumBytes) failSystemd();
    return content.subarray(0, size).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
};

const digestRegularFile = (path) => {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = fstatSync(descriptor);
    if (
      !status.isFile() ||
      status.uid !== 0 ||
      status.gid !== 0 ||
      (status.mode & 0o022) !== 0 ||
      (status.mode & 0o111) === 0 ||
      status.size < 1 ||
      status.size > maximumManagerBytes
    )
      failSystemd();
    const hash = createHash("sha256");
    const content = Buffer.alloc(64 * 1024);
    let total = 0;
    while (total < status.size) {
      const count = readSync(descriptor, content, 0, content.length, null);
      if (count === 0) failSystemd();
      total += count;
      if (total > status.size) failSystemd();
      hash.update(content.subarray(0, count));
    }
    const after = fstatSync(descriptor);
    if (
      after.dev !== status.dev ||
      after.ino !== status.ino ||
      after.mode !== status.mode ||
      after.uid !== status.uid ||
      after.gid !== status.gid ||
      after.size !== status.size
    )
      failSystemd();
    return Object.freeze({
      dev: status.dev,
      digest: hash.digest("hex"),
      gid: status.gid,
      ino: status.ino,
      mode: status.mode,
      size: status.size,
      uid: status.uid,
    });
  } finally {
    closeSync(descriptor);
  }
};

const readPid1Snapshot = () => {
  const processStat = readBounded("/proc/1/stat", 4096).trimEnd();
  if (!processStat.startsWith("1 (") || /[\0\r\n]/u.test(processStat))
    failSystemd();
  const commandEnd = processStat.lastIndexOf(") ");
  if (commandEnd < 4) failSystemd();
  const fields = processStat.slice(commandEnd + 2).split(" ");
  const startTime = fields[19];
  const bootId = readBounded("/proc/sys/kernel/random/boot_id", 128).trimEnd();
  if (
    fields.length < 20 ||
    !/^[A-Z]$/u.test(fields[0] ?? "") ||
    !/^[1-9][0-9]*$/u.test(startTime ?? "") ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      bootId,
    )
  )
    failSystemd();
  return Object.freeze({ bootId, startTime });
};

const readProcessSnapshot = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) failSystemd();
  const processStat = readBounded(`/proc/${pid}/stat`, 4096).trimEnd();
  if (!processStat.startsWith(`${pid} (`) || /[\0\r\n]/u.test(processStat))
    failSystemd();
  const commandEnd = processStat.lastIndexOf(") ");
  if (commandEnd < String(pid).length + 3) failSystemd();
  const fields = processStat.slice(commandEnd + 2).split(" ");
  const processGroup = fields[2];
  const startTime = fields[19];
  const bootId = readBounded("/proc/sys/kernel/random/boot_id", 128).trimEnd();
  if (
    fields.length < 20 ||
    !/^[A-Z]$/u.test(fields[0] ?? "") ||
    !/^[1-9][0-9]*$/u.test(processGroup ?? "") ||
    !/^[1-9][0-9]*$/u.test(startTime ?? "") ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      bootId,
    )
  )
    failSystemd();
  return Object.freeze({
    bootId,
    pid,
    processGroup: Number(processGroup),
    startTime,
  });
};

export const validateToolLeaderSnapshot = (expected, observed) =>
  expected?.pid === observed?.pid &&
  expected.pid === expected.processGroup &&
  observed.pid === observed.processGroup &&
  expected.bootId === observed.bootId &&
  expected.startTime === observed.startTime;

export const classifyToolSettlement = ({
  deadline,
  forceAttempted,
  groupAbsent,
  now,
  terminalObserved,
}) => {
  if (
    typeof forceAttempted !== "boolean" ||
    typeof groupAbsent !== "boolean" ||
    typeof terminalObserved !== "boolean" ||
    !Number.isFinite(now) ||
    !Number.isFinite(deadline)
  )
    failSystemd();
  if (now >= deadline) return "failure";
  if (!(groupAbsent && terminalObserved)) return "wait";
  return forceAttempted ? "failure" : "terminal";
};

export const advanceToolForceState = ({
  absenceProved,
  forceAttempted,
  forceDeadline,
  groupAbsent,
  now,
}) => {
  if (
    typeof absenceProved !== "boolean" ||
    typeof forceAttempted !== "boolean" ||
    typeof groupAbsent !== "boolean" ||
    !Number.isFinite(forceDeadline) ||
    !Number.isFinite(now)
  )
    failSystemd();
  const reappeared = absenceProved && !groupAbsent;
  const nextAbsenceProved =
    absenceProved || (groupAbsent && now < forceDeadline);
  const shouldForce =
    !forceAttempted &&
    now >= forceDeadline &&
    (!nextAbsenceProved || reappeared);
  return Object.freeze({
    absenceProved: nextAbsenceProved,
    forceAttempted: forceAttempted || shouldForce,
    reappeared,
    shouldForce,
  });
};

const executableMetadata = (status) =>
  Object.freeze({
    dev: status.dev,
    gid: status.gid,
    ino: status.ino,
    mode: status.mode,
    size: status.size,
    uid: status.uid,
  });

const validMappedExecutable = (status) =>
  status.isFile() &&
  (status.mode & 0o111) !== 0 &&
  status.size > 0 &&
  status.size <= maximumNodeBytes;

export const transferDescriptorAuthority = ({ close, construct, open }) => {
  const descriptor = open();
  let transferred = false;
  try {
    const authority = construct(descriptor);
    transferred = true;
    return authority;
  } finally {
    if (!transferred) close(descriptor);
  }
};

const digestRetainedExecutable = (descriptor, status, deadline) => {
  const hash = createHash("sha256");
  const content = Buffer.alloc(1024 * 1024);
  let total = 0;
  while (total < status.size) {
    remainingMilliseconds(deadline);
    const count = readSync(descriptor, content, 0, content.length, null);
    if (count === 0) failSystemd();
    total += count;
    if (total > status.size) failSystemd();
    hash.update(content.subarray(0, count));
  }
  return hash.digest("hex");
};

const sameExecutableIdentity = (left, right) =>
  left?.dev === right?.dev &&
  left?.ino === right?.ino &&
  left?.mode === right?.mode &&
  left?.uid === right?.uid &&
  left?.gid === right?.gid &&
  left?.size === right?.size &&
  left?.digest === right?.digest;

export const validateLiveMappedExecutable = ({ after, before }) => {
  if (!Number.isSafeInteger(before?.pid) || before.pid <= 1) return false;
  return (
    before.pid === after?.pid &&
    before.bootId === after?.bootId &&
    before.startTime === after?.startTime &&
    sameExecutableIdentity(before.executable, after?.executable)
  );
};

const captureLiveMappedExecutable = (executable, deadline) => {
  if (executable !== process.execPath) failSystemd();
  return transferDescriptorAuthority({
    close: closeSync,
    construct: (descriptor) => {
      const before = fstatSync(descriptor);
      if (!validMappedExecutable(before)) failSystemd();
      const named = statSync(executable);
      if (
        !named.isFile() ||
        named.dev !== before.dev ||
        named.ino !== before.ino
      )
        failSystemd();
      const digest = digestRetainedExecutable(descriptor, before, deadline);
      const after = fstatSync(descriptor);
      const executableIdentity = {
        ...executableMetadata(before),
        digest,
      };
      if (
        !sameExecutableIdentity(executableIdentity, {
          ...executableMetadata(after),
          digest,
        })
      )
        failSystemd();
      return Object.freeze({
        ...readProcessSnapshot(process.pid),
        descriptor,
        executable: Object.freeze(executableIdentity),
      });
    },
    // Linux binds an open file description to the mapped executable inode;
    // O_RDONLY retains that immutable execution authority without granting a
    // pathname or write channel to later lifecycle code.
    open: () => openSync(`/proc/${process.pid}/exe`, constants.O_RDONLY),
  });
};

const recheckLiveMappedExecutable = (expected) => {
  const descriptorStatus = fstatSync(expected.descriptor);
  const descriptorPath = `/proc/${expected.pid}/fd/${expected.descriptor}`;
  const descriptorPathStatus = statSync(descriptorPath);
  const processMappingStatus = statSync(`/proc/${expected.pid}/exe`);
  const snapshot = readProcessSnapshot(expected.pid);
  const observed = Object.freeze({
    ...snapshot,
    executable: Object.freeze({
      ...executableMetadata(descriptorStatus),
      digest: expected.executable.digest,
    }),
  });
  if (
    !validMappedExecutable(descriptorStatus) ||
    descriptorPathStatus.dev !== descriptorStatus.dev ||
    descriptorPathStatus.ino !== descriptorStatus.ino ||
    processMappingStatus.dev !== descriptorStatus.dev ||
    processMappingStatus.ino !== descriptorStatus.ino ||
    !validateLiveMappedExecutable({
      after: observed,
      before: expected,
    })
  )
    failSystemd();
  return descriptorPath;
};

const preparedSystemdState = (preparation) => {
  const state =
    preparation !== null && typeof preparation === "object"
      ? systemdPreparations.get(preparation)
      : undefined;
  if (state === undefined || state.closed || state.consumed) failSystemd();
  return state;
};

export const closePreparedGithubSystemdSupervision = (preparation) => {
  const state =
    preparation !== null && typeof preparation === "object"
      ? systemdPreparations.get(preparation)
      : undefined;
  if (state === undefined) failSystemd();
  if (state.closed) return Promise.resolve(false);
  return closePreparedSystemdState(state);
};

export const snapshotSystemdEnvironment = (environment) => {
  if (
    environment === null ||
    typeof environment !== "object" ||
    Array.isArray(environment) ||
    Object.getOwnPropertySymbols(environment).length !== 0
  )
    failSystemd();
  const descriptors = Object.getOwnPropertyDescriptors(environment);
  const names = Object.keys(descriptors).sort();
  if (names.length > 128) failSystemd();
  const entries = names.map((name) => {
    const descriptor = descriptors[name];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      (typeof descriptor.value !== "string" && descriptor.value !== undefined)
    )
      failSystemd();
    return [name, descriptor.value];
  });
  return Object.freeze(Object.fromEntries(entries));
};

export const sameSystemdEnvironment = (expected, observed) => {
  let snapshot;
  try {
    snapshot = snapshotSystemdEnvironment(observed);
  } catch {
    return false;
  }
  const expectedNames = Object.keys(expected);
  const observedNames = Object.keys(snapshot);
  return (
    expectedNames.length === observedNames.length &&
    expectedNames.every(
      (name, index) =>
        name === observedNames[index] && expected[name] === snapshot[name],
    )
  );
};

export const snapshotSystemdArguments = (arguments_) => {
  if (!Array.isArray(arguments_)) failSystemd();
  const descriptors = Object.getOwnPropertyDescriptors(arguments_);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol"))
    failSystemd();
  const length = descriptors.length;
  if (
    length === undefined ||
    !("value" in length) ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0 ||
    length.value > 128
  )
    failSystemd();
  const names = Object.getOwnPropertyNames(descriptors);
  if (
    names.length !== length.value + 1 ||
    !names.every(
      (name) =>
        name === "length" ||
        (/^(?:0|[1-9][0-9]{0,2})$/u.test(name) && Number(name) < length.value),
    )
  )
    failSystemd();
  const snapshot = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = descriptors[index];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      descriptor.value.length > 4096 ||
      descriptor.value.includes("\0")
    )
      failSystemd();
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
};

export const sameSystemdArguments = (expected, observed) => {
  let snapshot;
  try {
    snapshot = snapshotSystemdArguments(observed);
  } catch {
    return false;
  }
  return (
    snapshot.length === expected.length &&
    snapshot.every((argument, index) => argument === expected[index])
  );
};

export const validateRootPid1Probe = ({
  after,
  before,
  digestOutput,
  firstTarget,
  manager,
  secondTarget,
  statOutput,
}) =>
  before?.bootId === after?.bootId &&
  before?.startTime === after?.startTime &&
  firstTarget === `${systemdPath}\n` &&
  secondTarget === firstTarget &&
  statOutput ===
    `${manager.dev}:${manager.ino}:${manager.mode.toString(16)}:${manager.uid}:${manager.gid}:${manager.size}\n` &&
  digestOutput === `${manager.digest} *${"/proc/1/exe"}\0`;

export const rootPid1ProbeRequired = (error) =>
  error !== null &&
  typeof error === "object" &&
  (error.code === "EACCES" || error.code === "EPERM");

const authenticateExecutable = (path, mode) => {
  if (realpathSync(path) !== path) failSystemd();
  const status = statSync(path);
  if (
    !status.isFile() ||
    status.uid !== 0 ||
    (status.mode & 0o022) !== 0 ||
    (status.mode & mode) !== mode
  )
    failSystemd();
};

const authenticateRootOwnedComponents = (path) => {
  if (!isAbsolute(path)) failSystemd();
  const root = lstatSync("/");
  if (
    !root.isDirectory() ||
    root.uid !== 0 ||
    root.gid !== 0 ||
    (root.mode & 0o022) !== 0
  )
    failSystemd();
  const components = path.split("/").filter(Boolean);
  let current = "/";
  for (const component of components.slice(0, -1)) {
    current = resolve(current, component);
    const status = lstatSync(current);
    if (
      !status.isDirectory() ||
      status.uid !== 0 ||
      status.gid !== 0 ||
      (status.mode & 0o022) !== 0
    )
      failSystemd();
  }
};

const pythonAuthority = () => {
  let current = pythonPath;
  const visited = new Set();
  for (let depth = 0; depth < 8; depth += 1) {
    if (visited.has(current)) failSystemd();
    visited.add(current);
    authenticateRootOwnedComponents(current);
    const lexical = lstatSync(current);
    if (!lexical.isSymbolicLink()) {
      if (realpathSync(pythonPath) !== current) failSystemd();
      return Object.freeze({
        canonical: current,
        ...digestRegularFile(current),
      });
    }
    if (lexical.uid !== 0 || lexical.gid !== 0) failSystemd();
    const target = readlinkSync(current);
    if (target.length < 1 || target.length > 4096 || /[\0\r\n]/u.test(target))
      failSystemd();
    current = isAbsolute(target)
      ? resolve(target)
      : resolve(dirname(current), target);
  }
  failSystemd();
};

export const validatePythonAuthority = ({ after, before, probe }) =>
  probe === pythonCapabilityReceipt &&
  before?.canonical === after?.canonical &&
  sameExecutableIdentity(before, after);

const authenticatePython = async (deadline) => {
  const before = pythonAuthority();
  let probe;
  try {
    probe = await runTool(
      pythonPath,
      ["-I", "-S", "-c", pythonCapabilitySource],
      deadline,
    );
  } catch {
    failSystemdTool("startup");
  }
  const after = pythonAuthority();
  if (!validatePythonAuthority({ after, before, probe })) failSystemd();
};

const authenticateSystemdHost = async (deadline) => {
  if (
    process.platform !== "linux" ||
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    process.getuid?.() === 0
  )
    failSystemd();
  authenticateExecutable(sudoPath, 0o4000);
  await authenticatePython(deadline);
  authenticateExecutable(systemctlPath, 0o111);
  authenticateExecutable(systemdRunPath, 0o111);
  authenticateExecutable(timeoutPath, 0o111);
  const manager = digestRegularFile(systemdPath);
  let directTarget;
  try {
    directTarget = realpathSync("/proc/1/exe");
  } catch (error) {
    if (!rootPid1ProbeRequired(error)) failSystemd();
    authenticateExecutable(readlinkPath, 0o111);
    authenticateExecutable(sha256sumPath, 0o111);
    authenticateExecutable(statPath, 0o111);
    const before = readPid1Snapshot();
    const firstTarget = await rootTool(
      readlinkPath,
      ["--canonicalize-existing", "--", "/proc/1/exe"],
      deadline,
      { operation: "pid1-readlink-1" },
    );
    const statOutput = await rootTool(
      statPath,
      ["--dereference", "--format=%d:%i:%f:%u:%g:%s", "--", "/proc/1/exe"],
      deadline,
      { operation: "pid1-stat" },
    );
    const digestOutput = await rootTool(
      sha256sumPath,
      ["--binary", "--zero", "--", "/proc/1/exe"],
      deadline,
      { operation: "pid1-digest" },
    );
    const secondTarget = await rootTool(
      readlinkPath,
      ["--canonicalize-existing", "--", "/proc/1/exe"],
      deadline,
      { operation: "pid1-readlink-2" },
    );
    const after = readPid1Snapshot();
    if (
      !validateRootPid1Probe({
        after,
        before,
        digestOutput,
        firstTarget,
        manager,
        secondTarget,
        statOutput,
      })
    )
      failSystemd();
  }
  if (directTarget !== undefined && directTarget !== systemdPath) failSystemd();
  const mounts = readBounded("/proc/self/mountinfo", 1024 * 1024)
    .trimEnd()
    .split("\n")
    .filter((line) => line.includes(" - cgroup2 "));
  if (
    mounts.length !== 1 ||
    mounts[0].split(" ")[4] !== cgroupRoot ||
    !existsSync(resolve(cgroupRoot, "cgroup.controllers"))
  )
    failSystemd();
};

const remainingMilliseconds = (deadline) => {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining < 1) failSystemd();
  return remaining;
};

export const rootToolHasPreparationBudget = (deadline, now) =>
  Number.isFinite(deadline) &&
  Number.isFinite(now) &&
  deadline - now >
    rootToolSentinelPreparationMilliseconds +
      rootToolHelperTeardownReserveMilliseconds;

export const systemdConsumptionDeadlines = (maximumMilliseconds, now) => {
  if (
    !Number.isSafeInteger(maximumMilliseconds) ||
    maximumMilliseconds < 1 ||
    !Number.isFinite(now) ||
    now < 0
  )
    failSystemd();
  const deadlineAnchor = Math.floor(now);
  const deadline = deadlineAnchor + maximumMilliseconds;
  const executionDeadline = deadline - containmentProofMilliseconds;
  if (
    !Number.isSafeInteger(deadlineAnchor) ||
    !Number.isSafeInteger(deadline) ||
    deadline <= now ||
    deadline - deadlineAnchor !== maximumMilliseconds ||
    executionDeadline <= now ||
    executionDeadline >= deadline ||
    deadline - executionDeadline !== containmentProofMilliseconds
  )
    failSystemd();
  return Object.freeze({ deadline, executionDeadline });
};

const clockBoottimeNanoseconds = () => {
  const uptime = readBounded("/proc/uptime", 128).trimEnd().split(" ")[0];
  if (!/^(?:0|[1-9][0-9]*)\.[0-9]{2}$/u.test(uptime ?? "")) failSystemd();
  const [seconds, fraction] = uptime.split(".");
  return BigInt(seconds) * 1_000_000_000n + BigInt(fraction) * 10_000_000n;
};

const absoluteBoottimeDeadline = (deadline) => {
  const remaining = remainingMilliseconds(deadline);
  return clockBoottimeNanoseconds() + BigInt(remaining) * 1_000_000n;
};

const toolTerminalOutcome = ({
  acceptClosedFailure,
  authorityUncertain,
  childError,
  chunks,
  size,
  terminal: { code, signal },
}) => {
  const error =
    childError !== undefined ||
    authorityUncertain ||
    (!acceptClosedFailure && code !== 0) ||
    (acceptClosedFailure && code !== 0 && code !== 1) ||
    signal !== null ||
    size > maximumToolOutputBytes;
  if (error)
    return Object.freeze({
      error: new Error("integration.controller.systemd-tool"),
    });
  const output = Buffer.concat(chunks).toString("utf8");
  return Object.freeze({
    value: acceptClosedFailure ? Object.freeze({ code, output }) : output,
  });
};

const runTool = (
  executable,
  arguments_,
  deadline,
  { acceptClosedFailure = false, forceDeadline } = {},
) =>
  new Promise((resolveTool, rejectTool) => {
    const timeout = remainingMilliseconds(deadline);
    const boundedForceDeadline = forceDeadline ?? deadline;
    if (
      timeout <= 0 ||
      boundedForceDeadline > deadline ||
      boundedForceDeadline < performance.now()
    )
      failSystemd();
    let settled = false;
    let childError;
    let terminal;
    let forced = false;
    let absenceProved = false;
    let authorityUncertain = false;
    let size = 0;
    const chunks = [];
    const child = spawn(executable, arguments_, {
      detached: true,
      env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!Number.isSafeInteger(child.pid) || child.pid < 1) failSystemd();
    let leader;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolveTool(value);
      else rejectTool(error);
    };
    const checkSettlement = () => {
      if (settled) return;
      const now = performance.now();
      let absent = false;
      try {
        absent = groupIsAbsent(child.pid);
      } catch {
        authorityUncertain = true;
      }
      const forceState = advanceToolForceState({
        absenceProved,
        forceAttempted: forced,
        forceDeadline: boundedForceDeadline,
        groupAbsent: absent,
        now,
      });
      absenceProved = forceState.absenceProved;
      forced = forceState.forceAttempted;
      if (forceState.reappeared) authorityUncertain = true;
      if (forceState.shouldForce) {
        authorityUncertain = true;
        try {
          if (leader === undefined) failSystemd();
          const observed = readProcessSnapshot(child.pid);
          if (!validateToolLeaderSnapshot(leader, observed)) failSystemd();
          signalGroup(child.pid, "SIGKILL");
        } catch {
          // A disappeared group is proved below. Every other identity or signal
          // ambiguity remains terminal uncertainty and can never authorize a
          // successful root-tool receipt.
          authorityUncertain = true;
        }
      }
      const decision = classifyToolSettlement({
        deadline,
        forceAttempted: forced,
        groupAbsent: absent,
        now,
        terminalObserved: terminal !== undefined,
      });
      if (decision === "terminal") {
        const outcome = toolTerminalOutcome({
          acceptClosedFailure,
          authorityUncertain,
          childError,
          chunks,
          size,
          terminal,
        });
        finish(outcome.error, outcome.value);
        return;
      }
      if (decision === "failure") {
        finish(new Error("integration.controller.systemd-tool"));
        return;
      }
      const nextBoundary = forced ? deadline : boundedForceDeadline;
      timer = setTimeout(
        checkSettlement,
        Math.max(1, Math.min(containmentPollMilliseconds, nextBoundary - now)),
      );
    };
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size <= maximumToolOutputBytes) chunks.push(chunk);
    });
    child.once("error", (error) => {
      childError = error;
      checkSettlement();
    });
    child.once("close", (code, signal) => {
      terminal = Object.freeze({ code, signal });
      checkSettlement();
    });
    try {
      const observed = readProcessSnapshot(child.pid);
      if (observed.processGroup !== child.pid) failSystemd();
      leader = observed;
    } catch {
      // The wrapper already exists, so initial identity uncertainty must use
      // the same bounded close/absence envelope rather than rejecting early.
      authorityUncertain = true;
    }
    checkSettlement();
  });

const rootTool = (
  path,
  arguments_,
  deadline,
  { mutationDeadline, operation, unit = "" },
) => {
  const timeout = remainingMilliseconds(deadline);
  const observationDeadline = deadline + rootToolJoinReserveMilliseconds;
  const forceDeadline = deadline + rootToolKillAfterMilliseconds;
  if (
    !rootToolHasPreparationBudget(deadline, performance.now()) ||
    timeout <= rootToolKillAfterMilliseconds + rootToolJoinReserveMilliseconds
  )
    failSystemd();
  const rootTimeoutSeconds = `${(timeout / 1_000).toFixed(3)}s`;
  const killAfterSeconds = `${(rootToolKillAfterMilliseconds / 1_000).toFixed(
    3,
  )}s`;
  const absoluteDeadline = absoluteBoottimeDeadline(deadline);
  const effectiveMutationDeadline =
    mutationDeadline ?? deadline - rootToolJoinReserveMilliseconds;
  const absoluteMutationDeadline = absoluteBoottimeDeadline(
    effectiveMutationDeadline,
  );
  if (
    absoluteMutationDeadline >= absoluteDeadline ||
    rootToolOperations.get(operation) !== path
  )
    failSystemd();
  const receiptKey = randomBytes(32).toString("hex");
  const encodedArguments = Buffer.from(JSON.stringify(arguments_)).toString(
    "base64url",
  );
  return runTool(
    sudoPath,
    [
      "-n",
      timeoutPath,
      "--signal=TERM",
      `--kill-after=${killAfterSeconds}`,
      rootTimeoutSeconds,
      pythonPath,
      "-I",
      "-S",
      "-c",
      rootHelperSource,
      String(absoluteDeadline),
      String(absoluteMutationDeadline),
      operation,
      path,
      encodedArguments,
      unit,
      receiptKey,
    ],
    observationDeadline,
    { acceptClosedFailure: true, forceDeadline },
  ).then((terminal) => {
    const parsed = validateRootToolReceipt({
      identity: {
        cutoff: String(absoluteMutationDeadline),
        deadline: String(absoluteDeadline),
        operation,
        unit,
      },
      key: receiptKey,
      receipt: terminal.output,
    });
    if (
      parsed === undefined ||
      (terminal.code === 0) !== (parsed.status === "ok") ||
      (terminal.code === 1) !==
        (parsed.status === "error" || parsed.status === "uncertain")
    )
      failSystemd();
    if (parsed.status !== "ok") failSystemdTool(parsed.stage, parsed.reason);
    return parsed.output;
  });
};

const exactUnitFacts = (output) => {
  if (Buffer.byteLength(output) > maximumToolOutputBytes) failSystemd();
  const entries = output.trimEnd().split("\n");
  const facts = Object.create(null);
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator < 1) failSystemd();
    const key = entry.slice(0, separator);
    if (Object.hasOwn(facts, key)) failSystemd();
    facts[key] = entry.slice(separator + 1);
  }
  return facts;
};

const unitProperties = [
  "ActiveState",
  "AmbientCapabilities",
  "CapabilityBoundingSet",
  "ControlGroup",
  "Delegate",
  "ExecMainCode",
  "ExecMainStatus",
  "Group",
  "Id",
  "InaccessiblePaths",
  "KillMode",
  "LoadState",
  "NoNewPrivileges",
  "ProtectControlGroups",
  "RemainAfterExit",
  "RestrictSUIDSGID",
  "Result",
  "SubState",
  "SupplementaryGroups",
  "User",
];

const showUnitOutput = (unit, deadline, operation) =>
  rootTool(
    systemctlPath,
    [
      "show",
      "--no-pager",
      ...unitProperties.map((property) => `--property=${property}`),
      unit,
    ],
    deadline,
    { operation, unit },
  );

const showUnit = async (unit, deadline, operation) =>
  exactUnitFacts(await showUnitOutput(unit, deadline, operation));

export const classifySystemdUnitAuthority = (facts, authority) => {
  if (facts.LoadState !== "loaded") return "load";
  if (facts.Id !== authority.unit) return "identity";
  if (facts.ControlGroup !== authority.cgroup) return "cgroup";
  if (
    facts.Delegate !== "no" ||
    facts.KillMode !== "control-group" ||
    facts.NoNewPrivileges !== "yes" ||
    facts.RestrictSUIDSGID !== "yes" ||
    facts.CapabilityBoundingSet !== "" ||
    facts.AmbientCapabilities !== "" ||
    facts.ProtectControlGroups !== "yes" ||
    facts.InaccessiblePaths !== systemdInaccessiblePaths ||
    facts.RemainAfterExit !== "yes"
  )
    return "hardening";
  if (
    facts.User !== String(authority.uid) ||
    facts.Group !== String(authority.gid) ||
    facts.SupplementaryGroups !== authority.groups.join(" ")
  )
    return "principal";
  return undefined;
};

export const classifyRetirementSystemdUnitAuthority = (
  facts,
  authority,
  before,
  after,
) => {
  if (
    typeof before?.absent !== "boolean" ||
    typeof after?.absent !== "boolean" ||
    typeof before?.empty !== "boolean" ||
    typeof after?.empty !== "boolean" ||
    (before.absent && !before.empty) ||
    (after.absent && !after.empty) ||
    before.absent !== after.absent ||
    !before.empty ||
    !after.empty
  )
    return "cgroup";
  const immutableMismatch = classifySystemdUnitAuthority(
    { ...facts, ControlGroup: authority.cgroup },
    authority,
  );
  if (immutableMismatch !== undefined) return immutableMismatch;
  if (before.absent) return facts.ControlGroup === "" ? undefined : "cgroup";
  return facts.ControlGroup === authority.cgroup ? undefined : "cgroup";
};

const assertUnitAuthority = (facts, authority) => {
  if (classifySystemdUnitAuthority(facts, authority) !== undefined)
    failSystemd();
};

export const authenticateCgroup = (cgroupPath) => {
  const descriptors = [];
  const identities = [];
  for (const [index, path] of [
    dirname(cgroupPath),
    cgroupPath,
    resolve(cgroupPath, "cgroup.procs"),
    resolve(cgroupPath, "cgroup.events"),
  ].entries()) {
    const status = lstatSync(path);
    if (
      (index < 2 ? !status.isDirectory() : !status.isFile()) ||
      status.uid !== 0 ||
      status.gid !== 0 ||
      (status.mode & 0o022) !== 0
    )
      failSystemd();
    identities.push(
      Object.freeze({
        dev: status.dev,
        gid: status.gid,
        ino: status.ino,
        mode: status.mode,
        uid: status.uid,
      }),
    );
  }
  const paths = [
    dirname(cgroupPath),
    cgroupPath,
    resolve(cgroupPath, "cgroup.procs"),
    resolve(cgroupPath, "cgroup.events"),
  ];
  try {
    for (const [index, path] of paths.entries()) {
      const descriptor = openSync(
        path,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          constants.O_CLOEXEC |
          (index < 2 ? constants.O_DIRECTORY : 0),
      );
      descriptors.push(descriptor);
      const status = fstatSync(descriptor);
      const identity = identities[index];
      if (
        status.dev !== identity.dev ||
        status.ino !== identity.ino ||
        status.mode !== identity.mode ||
        status.uid !== identity.uid ||
        status.gid !== identity.gid
      )
        failSystemd();
    }
    return Object.freeze({
      descriptors: Object.freeze(descriptors),
      identities: Object.freeze(identities),
    });
  } catch (error) {
    if (descriptors.length > 0) closeDescriptorSet(descriptors);
    throw error;
  }
};

const sameCgroupIdentity = (left, right) =>
  Array.isArray(left?.descriptors) &&
  Array.isArray(right?.descriptors) &&
  left.descriptors.length === 4 &&
  right.descriptors.length === 4 &&
  left.descriptors.every(
    (descriptor, index) => descriptor === right.descriptors[index],
  ) &&
  Array.isArray(left.identities) &&
  Array.isArray(right.identities) &&
  left.identities.length === 4 &&
  right.identities.length === 4 &&
  left.identities.every(
    (identity, index) =>
      identity.dev === right.identities[index]?.dev &&
      identity.gid === right.identities[index]?.gid &&
      identity.ino === right.identities[index]?.ino &&
      identity.mode === right.identities[index]?.mode &&
      identity.uid === right.identities[index]?.uid,
  );

const recheckCgroupAuthority = (cgroupPath, authority) => {
  const paths = [
    dirname(cgroupPath),
    cgroupPath,
    resolve(cgroupPath, "cgroup.procs"),
    resolve(cgroupPath, "cgroup.events"),
  ];
  const identities = paths.map((path) => {
    const status = lstatSync(path);
    return {
      dev: status.dev,
      gid: status.gid,
      ino: status.ino,
      mode: status.mode,
      uid: status.uid,
    };
  });
  const observed = { descriptors: authority.descriptors, identities };
  if (!sameCgroupIdentity(observed, authority)) failSystemd();
  for (const [index, descriptor] of authority.descriptors.entries()) {
    const status = fstatSync(descriptor);
    const identity = authority.identities[index];
    if (
      status.dev !== identity.dev ||
      status.ino !== identity.ino ||
      status.mode !== identity.mode ||
      status.uid !== identity.uid ||
      status.gid !== identity.gid
    )
      failSystemd();
  }
};

const recheckRetainedCgroupDescriptors = (authority) => {
  for (const [index, descriptor] of authority.descriptors.entries()) {
    const status = fstatSync(descriptor);
    const identity = authority.identities[index];
    if (
      status.dev !== identity.dev ||
      status.ino !== identity.ino ||
      status.mode !== identity.mode ||
      status.uid !== identity.uid ||
      status.gid !== identity.gid
    )
      failSystemd();
  }
};

const retainedCgroupIsEmpty = (authority, markDiagnostic = undefined) => {
  markDiagnostic?.("cgroup-retained");
  recheckRetainedCgroupDescriptors(authority);
  const content = Buffer.alloc(4097);
  let size = 0;
  while (size < content.length) {
    const count = readSync(
      authority.descriptors[3],
      content,
      size,
      content.length - size,
      size,
    );
    if (count === 0) break;
    size += count;
  }
  if (size > 4096) failSystemd();
  recheckRetainedCgroupDescriptors(authority);
  const events = content.subarray(0, size).toString("utf8");
  const entries = Object.fromEntries(
    events
      .trimEnd()
      .split("\n")
      .map((line) => line.split(" ")),
  );
  return entries.populated === "0";
};

export const exactPathIsAbsent = (path) => {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
};

export const closeDescriptorSet = (descriptors, close = closeSync) => {
  if (
    !Array.isArray(descriptors) ||
    descriptors.length === 0 ||
    new Set(descriptors).size !== descriptors.length ||
    !descriptors.every(Number.isSafeInteger) ||
    typeof close !== "function"
  )
    failSystemd();
  let closed = true;
  for (const descriptor of [...descriptors].reverse()) {
    try {
      close(descriptor);
    } catch {
      closed = false;
    }
  }
  return closed;
};

const observeAuthenticatedCgroup = (
  cgroupPath,
  authority,
  markDiagnostic = undefined,
) => {
  const parentPath = dirname(cgroupPath);
  const childPaths = [
    cgroupPath,
    resolve(cgroupPath, "cgroup.procs"),
    resolve(cgroupPath, "cgroup.events"),
  ];
  const recheckParentAndRetainedRoot = () => {
    const status = lstatSync(parentPath);
    const identity = authority.identities[0];
    if (
      !status.isDirectory() ||
      status.dev !== identity.dev ||
      status.ino !== identity.ino ||
      status.mode !== identity.mode ||
      status.uid !== identity.uid ||
      status.gid !== identity.gid
    )
      failSystemd();
    for (const index of [0, 1]) {
      const retainedStatus = fstatSync(authority.descriptors[index]);
      const retainedIdentity = authority.identities[index];
      if (
        retainedStatus.dev !== retainedIdentity.dev ||
        retainedStatus.ino !== retainedIdentity.ino ||
        retainedStatus.mode !== retainedIdentity.mode ||
        retainedStatus.uid !== retainedIdentity.uid ||
        retainedStatus.gid !== retainedIdentity.gid
      )
        failSystemd();
    }
  };
  const observePaths = () =>
    childPaths.map((path, index) => {
      try {
        const status = lstatSync(path);
        const identity = authority.identities[index + 1];
        if (
          status.dev !== identity.dev ||
          status.ino !== identity.ino ||
          status.mode !== identity.mode ||
          status.uid !== identity.uid ||
          status.gid !== identity.gid
        )
          failSystemd();
        return "present";
      } catch (error) {
        if (error?.code === "ENOENT") return "absent";
        throw error;
      }
    });
  const classifyPaths = () => {
    markDiagnostic?.("cgroup-retained");
    recheckParentAndRetainedRoot();
    markDiagnostic?.("cgroup-path");
    const first = observePaths();
    if (new Set(first).size !== 1) failSystemd();
    markDiagnostic?.("cgroup-retained");
    recheckParentAndRetainedRoot();
    markDiagnostic?.("cgroup-path");
    const second = observePaths();
    if (new Set(second).size !== 1) failSystemd();
    if (second[0] !== first[0]) {
      if (first[0] === "present" && second[0] === "absent") return "transition";
      failSystemd();
    }
    markDiagnostic?.("cgroup-retained");
    recheckParentAndRetainedRoot();
    return first[0];
  };
  const initial = classifyPaths();
  if (initial === "absent") return Object.freeze({ absent: true, empty: true });
  if (initial === "transition")
    return Object.freeze({ absent: false, empty: false });
  const empty = retainedCgroupIsEmpty(authority, markDiagnostic);
  const afterRead = classifyPaths();
  return Object.freeze({
    absent: afterRead === "absent",
    empty: afterRead === "absent" || (afterRead === "present" && empty),
  });
};

const authenticatedCgroupIsAbsent = (
  cgroupPath,
  authority,
  markDiagnostic = undefined,
) => observeAuthenticatedCgroup(cgroupPath, authority, markDiagnostic).absent;

const observeCgroupSettlement = (
  cgroupPath,
  identity,
  markDiagnostic = undefined,
) => {
  markDiagnostic?.("cgroup-retained");
  if (!sameCgroupIdentity(identity, identity)) failSystemd();
  const observation = observeAuthenticatedCgroup(
    cgroupPath,
    identity,
    markDiagnostic,
  );
  return observation.absent || observation.empty;
};

export const cgroupObservationSettled = (cgroupPath, identity) =>
  observeCgroupSettlement(cgroupPath, identity);

const waitForTerminal = async (state) => {
  while (
    !state.interrupted.value &&
    rootToolHasPreparationBudget(state.executionDeadline, performance.now())
  ) {
    let output;
    try {
      output = await showUnitOutput(
        state.authority.unit,
        state.executionDeadline,
        "unit-monitor",
      );
    } catch {
      failSystemdLifecycle(state, "terminal-wait", "unit-show");
    }
    let facts;
    try {
      facts = exactUnitFacts(output);
    } catch {
      failSystemdLifecycle(state, "terminal-wait", "unit-parse");
    }
    const mismatch = classifySystemdUnitAuthority(facts, state.authority);
    if (mismatch !== undefined)
      failSystemdLifecycle(state, "terminal-wait", `authority-${mismatch}`);
    if (systemdMainProcessIsTerminal(facts)) return facts;
    await delay(Math.min(50, remainingMilliseconds(state.executionDeadline)));
  }
  return undefined;
};

const systemdSignal = (unit, signal, deadline) =>
  rootTool(
    systemctlPath,
    ["kill", "--kill-whom=all", `--signal=${signal}`, unit],
    deadline,
    {
      operation: signal === "SIGTERM" ? "unit-kill-term" : "unit-kill-kill",
      unit,
    },
  );

const proveCollected = async (state) => {
  while (performance.now() < state.deadline) {
    let output;
    try {
      output = await showUnitOutput(
        state.authority.unit,
        state.deadline,
        "unit-collection",
      );
    } catch (error) {
      if (systemdToolFailureStage(error) !== undefined) throw error;
      failSystemdLifecycle(state, "collection", "unit-show");
    }
    let facts;
    try {
      facts = exactUnitFacts(output);
      const keys = Object.keys(facts);
      if (
        !Object.hasOwn(facts, "LoadState") ||
        keys.some((key) => !unitProperties.includes(key))
      )
        failSystemd();
    } catch {
      failSystemdLifecycle(state, "collection", "unit-facts");
    }
    if (facts.LoadState === "not-found") {
      let absent;
      try {
        absent = authenticatedCgroupIsAbsent(
          state.cgroupPath,
          state.cgroupIdentity,
        );
      } catch {
        failSystemdLifecycle(state, "collection", "cgroup-absence");
      }
      if (absent) return true;
    } else if (facts.LoadState !== "loaded") {
      failSystemdLifecycle(state, "collection", "load-state");
    }
    await delay(Math.min(50, remainingMilliseconds(state.deadline)));
  }
  return false;
};

const retireUnit = async (
  authority,
  deadline,
  lifecycleState,
  cgroupPath,
  cgroupIdentity,
) => {
  const markDiagnostic = (reason) => {
    if (lifecycleState === undefined) return;
    if (!systemdRetirementDiagnosticReasons.has(reason)) failSystemd();
    lifecycleState.retirementDiagnosticReason = reason;
  };
  if (cgroupPath === undefined || cgroupIdentity === undefined) failSystemd();
  const before = observeAuthenticatedCgroup(
    cgroupPath,
    cgroupIdentity,
    markDiagnostic,
  );
  let facts;
  try {
    if (lifecycleState !== undefined)
      lifecycleState.retirementDiagnosticReason = "unit-show";
    facts = await showUnit(authority.unit, deadline, "unit-retirement");
  } catch (error) {
    if (lifecycleState === undefined) throw error;
    rethrowSystemdLifecycle(lifecycleState, error, "unit-show");
  }
  if (facts.LoadState === "not-found") return;
  const after = observeAuthenticatedCgroup(
    cgroupPath,
    cgroupIdentity,
    markDiagnostic,
  );
  const mismatch = classifyRetirementSystemdUnitAuthority(
    facts,
    authority,
    before,
    after,
  );
  if (mismatch !== undefined) {
    if (lifecycleState === undefined) failSystemd();
    failSystemdLifecycle(lifecycleState, "retirement", `authority-${mismatch}`);
  }
  if (lifecycleState !== undefined)
    lifecycleState.retirementDiagnosticReason = "unit-command";
  if (facts.ActiveState === "failed")
    await rootTool(systemctlPath, ["reset-failed", authority.unit], deadline, {
      operation: "unit-reset",
      unit: authority.unit,
    });
  else
    await rootTool(systemctlPath, ["stop", authority.unit], deadline, {
      operation: "unit-stop",
      unit: authority.unit,
    });
};

const systemdEnvironmentArguments = (environment) =>
  Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      if (
        !/^[A-Z][A-Z0-9_]{0,63}$/u.test(name) ||
        forbiddenLifecycleEnvironment.has(name) ||
        typeof value !== "string" ||
        value.length > 4096 ||
        /[\0\r\n]/u.test(value)
      )
        failSystemd();
      return `--setenv=${name}=${value}`;
    });

const systemdIdentity = (environment) => {
  if (
    !/^\d+$/u.test(environment.GITHUB_RUN_ID ?? "") ||
    !/^\d+$/u.test(environment.GITHUB_RUN_ATTEMPT ?? "") ||
    !/^[a-f0-9]{40}$/u.test(environment.GITHUB_SHA ?? "") ||
    !/^\d+\/\d+$/u.test(environment.AGENTSCOPE_INTEGRATION_SHARD ?? "") ||
    !/^[12]$/u.test(environment.AGENTSCOPE_INTEGRATION_REPLAY ?? "") ||
    environment.GITHUB_ACTIONS !== "true" ||
    environment.RUNNER_ENVIRONMENT !== "github-hosted" ||
    environment.GITHUB_JOB !== "hermetic-platform" ||
    environment.GITHUB_REPOSITORY !== "Melbourneandrew/agentscope"
  )
    failSystemd();
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        attempt: environment.GITHUB_RUN_ATTEMPT,
        nonce: randomBytes(16).toString("hex"),
        run: environment.GITHUB_RUN_ID,
        replay: environment.AGENTSCOPE_INTEGRATION_REPLAY,
        sha: environment.GITHUB_SHA,
        shard: environment.AGENTSCOPE_INTEGRATION_SHARD,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  const unit = `agentscope-${digest}.service`;
  const groups = [...new Set(process.getgroups())].sort(
    (left, right) => left - right,
  );
  return Object.freeze({
    cgroup: `/system.slice/${unit}`,
    gid: process.getgid(),
    groups: Object.freeze(groups),
    uid: process.getuid(),
    unit,
  });
};

const systemdStartArguments = ({
  arguments_,
  authority,
  environment,
  executable,
}) => [
  `--unit=${authority.unit}`,
  "--service-type=exec",
  "--property=Delegate=no",
  "--property=KillMode=control-group",
  "--property=NoNewPrivileges=yes",
  "--property=RestrictSUIDSGID=yes",
  "--property=CapabilityBoundingSet=",
  "--property=AmbientCapabilities=",
  "--property=ProtectControlGroups=yes",
  `--property=InaccessiblePaths=${systemdInaccessiblePaths}`,
  "--property=RemainAfterExit=yes",
  `--property=User=${authority.uid}`,
  `--property=Group=${authority.gid}`,
  `--property=SupplementaryGroups=${authority.groups.join(" ")}`,
  "--expand-environment=no",
  `--working-directory=${process.cwd()}`,
  ...systemdEnvironmentArguments(environment),
  "--",
  executable,
  ...arguments_,
];

export const prepareGithubSystemdSupervision = async ({
  arguments_: suppliedArguments = [],
  environment,
  executable,
  maximumMilliseconds,
  stdio: suppliedStdio = "inherit",
}) => {
  if (
    !Number.isSafeInteger(maximumMilliseconds) ||
    maximumMilliseconds < 1 ||
    !isAbsolute(executable) ||
    realpathSync(executable) !== executable ||
    !["ignore", "inherit"].includes(suppliedStdio)
  )
    failSystemd();
  const preparationDeadline =
    performance.now() + systemdPreparationMilliseconds;
  const arguments_ = snapshotSystemdArguments(suppliedArguments);
  const environmentSnapshot = snapshotSystemdEnvironment(environment);
  await authenticateSystemdHost(preparationDeadline);
  const authority = systemdIdentity(environmentSnapshot);
  const cgroupPath = resolve(cgroupRoot, authority.cgroup.slice(1));
  if (existsSync(cgroupPath)) failSystemd();
  const mappedExecutable = captureLiveMappedExecutable(
    executable,
    preparationDeadline,
  );
  const interrupted = { value: false };
  const forwardSignal = () => {
    interrupted.value = true;
  };
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);
  const state = {
    arguments_,
    authority,
    cgroupPath,
    closed: false,
    consumed: false,
    deadline: undefined,
    environment: environmentSnapshot,
    executable,
    executionDeadline: undefined,
    forwardSignal,
    interrupted,
    mappedExecutable,
    maximumMilliseconds,
    preparationDeadline,
    retirementDiagnosticReason: undefined,
    stdio: suppliedStdio,
    cgroupIdentity: undefined,
    unitMayExist: false,
  };
  try {
    recheckLiveMappedExecutable(mappedExecutable);
    if (
      preparationDeadline <= performance.now() ||
      !exactPathIsAbsent(cgroupPath)
    )
      failSystemd();
    const preparation = Object.freeze({});
    systemdPreparations.set(preparation, state);
    return preparation;
  } catch (error) {
    await closePreparedSystemdState(state);
    if (systemdToolFailureStage(error) !== undefined) throw error;
    failSystemd();
  }
};

const closePreparedSystemdState = async (state) => {
  if (state.closed) return false;
  state.closed = true;
  let contained = !state.unitMayExist;
  try {
    if (state.unitMayExist) {
      if (
        !Number.isFinite(state.deadline) ||
        !Number.isFinite(state.executionDeadline)
      )
        failSystemd();
      if (!exactPathIsAbsent(state.cgroupPath)) {
        const cgroupIdentity =
          state.cgroupIdentity ?? authenticateCgroup(state.cgroupPath);
        state.cgroupIdentity = cgroupIdentity;
        await systemdSignal(state.authority.unit, "SIGKILL", state.deadline);
        while (!cgroupObservationSettled(state.cgroupPath, cgroupIdentity))
          await delay(Math.min(50, remainingMilliseconds(state.deadline)));
      }
      await retireUnit(
        state.authority,
        state.deadline,
        undefined,
        state.cgroupPath,
        state.cgroupIdentity,
      );
      contained = await proveCollected(state);
    }
  } catch {
    contained = false;
  } finally {
    process.removeListener("SIGINT", state.forwardSignal);
    process.removeListener("SIGTERM", state.forwardSignal);
    if (state.cgroupIdentity !== undefined) {
      if (!closeDescriptorSet(state.cgroupIdentity.descriptors)) {
        state.retirementDiagnosticReason = "descriptor-close";
        contained = false;
      }
      state.cgroupIdentity = undefined;
    }
    try {
      closeSync(state.mappedExecutable.descriptor);
    } catch {
      state.retirementDiagnosticReason = "descriptor-close";
      contained = false;
    }
  }
  return contained;
};

const systemdLifecycleReason = (state, fallback = "authority") => {
  if (state.interrupted.value) return "interrupted";
  const boundary = ["termination", "retirement", "collection"].includes(
    state.lifecyclePhase,
  )
    ? state.deadline
    : state.executionDeadline;
  return performance.now() >= boundary ? "deadline" : fallback;
};

const rethrowSystemdLifecycle = (state, error, fallback) => {
  if (systemdToolFailureStage(error) !== undefined) throw error;
  const diagnosticReason =
    state.lifecyclePhase === "retirement" &&
    fallback === "authority" &&
    systemdRetirementDiagnosticReasons.has(state.retirementDiagnosticReason)
      ? state.retirementDiagnosticReason
      : fallback;
  failSystemdLifecycle(
    state,
    state.lifecyclePhase,
    systemdLifecycleReason(state, diagnosticReason),
  );
};

const mappedExecutableForSystemd = (state) => {
  state.lifecyclePhase = "mapped-executable-pre-submit";
  try {
    return recheckLiveMappedExecutable(state.mappedExecutable);
  } catch (error) {
    rethrowSystemdLifecycle(state, error, "authority");
  }
};

const admitSystemdUnit = async (state) => {
  state.lifecyclePhase = "unit-admission";
  try {
    recheckLiveMappedExecutable(state.mappedExecutable);
    const admitted = await showUnit(
      state.authority.unit,
      state.executionDeadline,
      "unit-admission",
    );
    assertUnitAuthority(admitted, state.authority);
    state.cgroupIdentity = authenticateCgroup(state.cgroupPath);
  } catch (error) {
    rethrowSystemdLifecycle(state, error, "authority");
  }
};

const observeSystemdTerminal = async (state) => {
  state.lifecyclePhase = "terminal-wait";
  let terminal;
  try {
    terminal = await waitForTerminal(state);
  } catch (error) {
    rethrowSystemdLifecycle(state, error, "authority");
  }
  if (terminal === undefined)
    failSystemdLifecycle(
      state,
      "terminal-wait",
      systemdLifecycleReason(state, "deadline"),
    );
  return terminal;
};

const authenticateTerminalSystemdUnit = async (state) => {
  state.lifecyclePhase = "unit-authoritative";
  try {
    const authoritative = await showUnit(
      state.authority.unit,
      state.executionDeadline,
      "unit-authoritative",
    );
    assertUnitAuthority(authoritative, state.authority);
    recheckCgroupAuthority(state.cgroupPath, state.cgroupIdentity);
  } catch (error) {
    rethrowSystemdLifecycle(state, error, "authority");
  }
};

const observeSystemdCgroup = (state) => {
  state.lifecyclePhase = "cgroup-observation";
  try {
    return !cgroupObservationSettled(state.cgroupPath, state.cgroupIdentity);
  } catch (error) {
    rethrowSystemdLifecycle(state, error, "malformed");
  }
};

const terminateSystemdCgroup = async (state) => {
  state.lifecyclePhase = "termination";
  try {
    await systemdSignal(state.authority.unit, "SIGTERM", state.deadline);
    const grace = Math.min(
      state.deadline,
      performance.now() + systemdTerminationGraceMilliseconds,
    );
    while (
      performance.now() < grace &&
      !cgroupObservationSettled(state.cgroupPath, state.cgroupIdentity)
    )
      await delay(Math.min(50, remainingMilliseconds(state.deadline)));
    if (!cgroupObservationSettled(state.cgroupPath, state.cgroupIdentity))
      await systemdSignal(state.authority.unit, "SIGKILL", state.deadline);
  } catch (error) {
    rethrowSystemdLifecycle(state, error, "authority");
  }
};

const retireAndCollectSystemdUnit = async (state) => {
  state.lifecyclePhase = "retirement";
  try {
    const markDiagnostic = (reason) => {
      if (!systemdRetirementDiagnosticReasons.has(reason)) failSystemd();
      state.retirementDiagnosticReason = reason;
    };
    while (
      !observeCgroupSettlement(
        state.cgroupPath,
        state.cgroupIdentity,
        markDiagnostic,
      )
    )
      await delay(Math.min(50, remainingMilliseconds(state.deadline)));
    await retireUnit(
      state.authority,
      state.deadline,
      state,
      state.cgroupPath,
      state.cgroupIdentity,
    );
  } catch (error) {
    rethrowSystemdLifecycle(state, error, "authority");
  }
  state.lifecyclePhase = "collection";
  let contained;
  try {
    contained = await proveCollected(state);
  } catch (error) {
    rethrowSystemdLifecycle(state, error, "authority");
  }
  if (!contained) failSystemdLifecycle(state, "collection", "deadline");
};

const runSystemdSupervised = async ({
  arguments_: suppliedArguments = [],
  environment: suppliedEnvironment,
  executable,
  maximumMilliseconds,
  preparation,
  stdio: suppliedStdio = "inherit",
}) => {
  const prepared = preparation;
  const state = preparedSystemdState(prepared);
  if (
    !sameSystemdEnvironment(state.environment, suppliedEnvironment) ||
    !sameSystemdArguments(state.arguments_, suppliedArguments) ||
    state.executable !== executable ||
    state.maximumMilliseconds !== maximumMilliseconds ||
    state.stdio !== suppliedStdio
  ) {
    await closePreparedGithubSystemdSupervision(prepared);
    failSystemd();
  }
  state.consumed = true;
  const { authority } = state;
  if (state.preparationDeadline <= performance.now()) {
    await closePreparedGithubSystemdSupervision(prepared);
    failSystemd();
  }
  let deadline;
  let executionDeadline;
  try {
    ({ deadline, executionDeadline } = systemdConsumptionDeadlines(
      maximumMilliseconds,
      performance.now(),
    ));
  } catch (error) {
    await closePreparedGithubSystemdSupervision(prepared);
    throw error;
  }
  state.deadline = deadline;
  state.executionDeadline = executionDeadline;
  if (!exactPathIsAbsent(state.cgroupPath)) {
    await closePreparedGithubSystemdSupervision(prepared);
    failSystemd();
  }
  let terminal;
  let residualWorkObserved;
  let lifecycleFailed = false;
  let result;
  try {
    const mappedExecutablePath = mappedExecutableForSystemd(state);
    state.unitMayExist = true;
    await rootTool(
      systemdRunPath,
      systemdStartArguments({
        arguments_: state.arguments_,
        authority,
        environment: state.environment,
        executable: mappedExecutablePath,
      }),
      deadline,
      {
        mutationDeadline: executionDeadline,
        operation: "systemd-submit",
        unit: authority.unit,
      },
    );
    await admitSystemdUnit(state);
    terminal = await observeSystemdTerminal(state);
    await authenticateTerminalSystemdUnit(state);
    residualWorkObserved = observeSystemdCgroup(state);
    if (residualWorkObserved) await terminateSystemdCgroup(state);
    await retireAndCollectSystemdUnit(state);
    const code = parseSystemdMainExitStatus(terminal);
    if (code === undefined)
      failSystemdLifecycle(state, "unit-authoritative", "malformed");
    result = { code, contained: true, residualWorkObserved, signal: null };
  } catch (error) {
    lifecycleFailed = true;
    if (systemdToolFailureStage(error) !== undefined) throw error;
    rethrowSystemdLifecycle(state, error, "internal");
  } finally {
    const closed = await closePreparedGithubSystemdSupervision(prepared);
    if (!closed && !lifecycleFailed)
      failSystemdLifecycle(
        state,
        state.retirementDiagnosticReason === "descriptor-close"
          ? "retirement"
          : "collection",
        state.retirementDiagnosticReason === "descriptor-close"
          ? "descriptor-close"
          : "authority",
      );
  }
  return result;
};

export const runSupervisedProcess = async (options) => {
  if (options.containment === "github-systemd") {
    if (options.preparation === undefined) failSystemd();
    return runSystemdSupervised(options);
  }
  if (options.preparation !== undefined) {
    await closePreparedGithubSystemdSupervision(options.preparation);
    failSystemd();
  }
  return runProcessGroupSupervised(options);
};
