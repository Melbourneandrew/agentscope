const reporters = new WeakSet<object>();
const retrievers = new WeakSet<object>();

export const registerDestinationReporterForCore = (value: object): void => {
  reporters.add(value);
};

export const registerDestinationRetrieverForCore = (value: object): void => {
  retrievers.add(value);
};

export const isRegisteredDestinationReporter = (value: unknown): boolean =>
  typeof value === "object" && value !== null && reporters.has(value);

export const isRegisteredDestinationRetriever = (value: unknown): boolean =>
  typeof value === "object" && value !== null && retrievers.has(value);
