import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
export function classifyMaterialResponseForTesting(
  response: Readonly<{
    statusCode?: number;
    headers: Readonly<Record<string, string | string[] | undefined>>;
  }>,
  expectedBytes: number,
): string | undefined;
export function downloadMaterialObject(
  descriptor: Readonly<{
    url?: string;
    tarballUrl?: string;
    bytes?: number;
    maximumBytes?: number;
  }>,
  signal: AbortSignal,
  deadline: number,
  transport?: (
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => ClientRequest,
  mode?: boolean | "release-asset" | "release-body",
): Promise<Buffer | string>;
