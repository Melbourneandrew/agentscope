"use strict";

if (process.argv[2] === "forged") {
  process.stdout.write('{"outcome":"passed","observedValue":"packed-ok"}\n');
} else if (process.argv[2] === "partial") {
  process.stdout.write('{"outcome":"passed"');
  process.exitCode = 1;
} else if (process.argv[2] === "overflow") {
  process.stdout.write("x".repeat(5 * 1024 * 1024));
} else {
  throw new Error("destination.local-sqlite.native-hostile-fixture.invalid");
}
