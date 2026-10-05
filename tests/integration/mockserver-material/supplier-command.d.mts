/** Trusted command callback only; enclosing builder owns deadline/process set. */
export function runMockServerSupplierResearch(
  run: (
    file: string,
    args: string[],
    options: {
      cwd: string;
      env: Readonly<Record<string, string>>;
      maxBuffer: number;
    },
  ) => Promise<unknown>,
): Promise<void>;
