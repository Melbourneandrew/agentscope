import { Command } from "commander";
import { z } from "zod";

const metadataSchema = z.object({
  name: z.literal("agentscope"),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
  description: z.string().min(1),
});

const metadata = metadataSchema.parse({
  name: "agentscope",
  version: "0.1.0",
  description:
    "Capture coding-agent traces and report them to trace destinations.",
});

export type CliOutput = Readonly<{
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
}>;

const processOutput: CliOutput = {
  writeOut: process.stdout.write.bind(process.stdout),
  writeErr: process.stderr.write.bind(process.stderr),
};

export function createProgram(output: CliOutput = processOutput): Command {
  return new Command()
    .name(metadata.name)
    .description(metadata.description)
    .version(metadata.version, "-V, --version", "output the installed version")
    .showSuggestionAfterError()
    .showHelpAfterError()
    .configureOutput(output);
}
