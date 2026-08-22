#define _GNU_SOURCE

#include <errno.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ptrace.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static void fail(void) {
  fputs("destination.local-sqlite.native-exec-supervisor.invalid\n", stderr);
  exit(125);
}

static int clone_exec(void *unused) {
  (void)unused;
  char *const arguments[] = {(char *)"cc", NULL};
  char *const environment[] = {NULL};
  execve("/bin/false", arguments, environment);
  return 125;
}

static int run_clone_exec_hostile(void) {
  static unsigned char stack[64 * 1024] __attribute__((aligned(16)));
  int flags = CLONE_FILES | CLONE_FS | CLONE_SIGHAND | CLONE_THREAD | CLONE_VM;
  if (clone(clone_exec, stack + sizeof(stack), flags, NULL) < 0) return 125;
  for (;;) sched_yield();
}

static void record_exec(pid_t pid) {
  char proc_path[64];
  char executable[4096];
  int written = snprintf(proc_path, sizeof(proc_path), "/proc/%ld/exe", (long)pid);
  if (written < 1 || (size_t)written >= sizeof(proc_path)) fail();
  ssize_t bytes = readlink(proc_path, executable, sizeof(executable) - 1);
  if (bytes < 1 || (size_t)bytes >= sizeof(executable) - 1) fail();
  executable[bytes] = '\0';
  if (strchr(executable, '\n') != NULL || strchr(executable, '\t') != NULL) fail();
  if (strcmp(executable, "/run/rosetta/rosetta") == 0) return;
  if (strcmp(executable, "/usr/bin/rosetta-wrapper") != 0) {
    if (fprintf(stderr, "AGENTSCOPE_EXEC\t%s\n", executable) < 0) fail();
    if (fflush(stderr) != 0) fail();
    return;
  }
  written = snprintf(proc_path, sizeof(proc_path), "/proc/%ld/cmdline", (long)pid);
  if (written < 1 || (size_t)written >= sizeof(proc_path)) fail();
  FILE *command = fopen(proc_path, "rb");
  if (command == NULL) fail();
  size_t command_bytes = fread(executable, 1, sizeof(executable) - 1, command);
  if (ferror(command) || !feof(command) || fclose(command) != 0 || command_bytes < 1)
    fail();
  const char *logical = executable + strlen(executable) + 1;
  if (
      logical >= executable + command_bytes || logical[0] != '/' ||
      memchr(logical, '\n', strlen(logical)) != NULL ||
      memchr(logical, '\t', strlen(logical)) != NULL)
    fail();
  if (fprintf(stderr, "AGENTSCOPE_EXEC\t%s\n", logical) < 0) fail();
  if (fflush(stderr) != 0) fail();
}

int main(int argc, char **argv) {
  if (argc < 2) fail();
  pid_t child = fork();
  if (child < 0) fail();
  if (child == 0) {
    if (ptrace(PTRACE_TRACEME, 0, NULL, NULL) != 0) _exit(125);
    if (raise(SIGSTOP) != 0) _exit(125);
    if (argc == 2 && strcmp(argv[1], "--verify-clone-exec-observed") == 0)
      _exit(run_clone_exec_hostile());
    execvp(argv[1], &argv[1]);
    _exit(127);
  }

  int status = 0;
  if (waitpid(child, &status, 0) != child || !WIFSTOPPED(status)) fail();
  const long options = PTRACE_O_TRACECLONE | PTRACE_O_TRACEEXEC |
                       PTRACE_O_TRACEEXIT | PTRACE_O_TRACEFORK |
                       PTRACE_O_TRACEVFORK | PTRACE_O_EXITKILL;
  if (ptrace(PTRACE_SETOPTIONS, child, NULL, (void *)options) != 0) fail();
  if (ptrace(PTRACE_CONT, child, NULL, NULL) != 0) fail();

  int child_status = 125;
  for (;;) {
    pid_t observed = waitpid(-1, &status, __WALL);
    if (observed < 0) {
      if (errno == EINTR) continue;
      if (errno == ECHILD) break;
      fail();
    }
    if (WIFEXITED(status)) {
      if (observed == child) child_status = WEXITSTATUS(status);
      continue;
    }
    if (WIFSIGNALED(status)) {
      if (observed == child) child_status = 128 + WTERMSIG(status);
      continue;
    }
    if (!WIFSTOPPED(status)) fail();
    unsigned int event = (unsigned int)status >> 16;
    int signal_number = WSTOPSIG(status);
    if (event == PTRACE_EVENT_EXEC) record_exec(observed);
    if (
        event == PTRACE_EVENT_CLONE || event == PTRACE_EVENT_FORK ||
        event == PTRACE_EVENT_VFORK) {
      unsigned long created = 0;
      if (ptrace(PTRACE_GETEVENTMSG, observed, NULL, &created) != 0 || created == 0)
        fail();
      /* The new tracee inherits the options and reports its own initial stop.
       * Waiting for that stop while its creator remains stopped can deadlock
       * clone-thread creation, so resume the creator and handle the new task
       * only when waitpid reports it through the ordinary loop. */
    }
    int delivered =
        signal_number == SIGTRAP || signal_number == SIGSTOP ? 0 : signal_number;
    if (ptrace(PTRACE_CONT, observed, NULL, (void *)(long)delivered) != 0 &&
        errno != ESRCH)
      fail();
  }
  return child_status;
}
