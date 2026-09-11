const scenarioIdPattern = /^[a-z][a-z0-9-]{0,63}$/u;
const methodPattern = /^(?:GET|POST|PUT)$/u;
const pathPattern = /^\u002f[A-Za-z0-9._~!$&'()*+,;=:@%\u002f-]{0,511}$/u;
const tokenPattern = /^[a-z][a-z0-9-]{0,63}$/u;
const maximumEntries = 256;

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value, keys) =>
  isRecord(value) &&
  JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort());

const freeze = (value) => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

const translateModelRequest = (entry) => {
  if (
    !isRecord(entry) ||
    typeof entry.method !== "string" ||
    !methodPattern.test(entry.method) ||
    typeof entry.path !== "string" ||
    !pathPattern.test(entry.path)
  )
    throw new Error("integration.fixture.adapter-model-observation");
  return { method: entry.method, path: entry.path };
};

const translateDestinationEntry = (entry) => {
  if (
    !exactKeys(entry, [
      "operation",
      "method",
      "path",
      "bodyBytes",
      "outcome",
    ]) ||
    typeof entry.operation !== "string" ||
    !tokenPattern.test(entry.operation) ||
    typeof entry.method !== "string" ||
    !methodPattern.test(entry.method) ||
    typeof entry.path !== "string" ||
    !pathPattern.test(entry.path) ||
    !Number.isSafeInteger(entry.bodyBytes) ||
    entry.bodyBytes < 0 ||
    entry.bodyBytes > 1024 * 1024 + 1 ||
    typeof entry.outcome !== "string" ||
    !tokenPattern.test(entry.outcome)
  )
    throw new Error("integration.fixture.adapter-destination-observation");
  return { ...entry };
};

const translateDestinationLedger = (ledger, scenarioId) => {
  if (
    !exactKeys(ledger, ["ledgerVersion", "scenarioId", "entries"]) ||
    ledger.ledgerVersion !== 1 ||
    ledger.scenarioId !== scenarioId ||
    !Array.isArray(ledger.entries) ||
    ledger.entries.length > maximumEntries
  )
    throw new Error("integration.fixture.adapter-destination-ledger");
  return ledger.entries.map(translateDestinationEntry);
};

const translateEventObservation = (observation, scenarioId) => {
  if (
    !exactKeys(observation, [
      "observationVersion",
      "scenarioId",
      "eventKindSets",
    ]) ||
    observation.observationVersion !== 1 ||
    observation.scenarioId !== scenarioId ||
    !Array.isArray(observation.eventKindSets) ||
    observation.eventKindSets.length > maximumEntries
  )
    throw new Error("integration.fixture.adapter-event-observation");
  return observation.eventKindSets.map((eventKinds) => {
    if (
      !Array.isArray(eventKinds) ||
      eventKinds.length > 32 ||
      eventKinds.some(
        (eventKind) =>
          typeof eventKind !== "string" || !tokenPattern.test(eventKind),
      )
    )
      throw new Error("integration.fixture.adapter-event-observation");
    return [...eventKinds];
  });
};

// A scenario adapter translates native observation shapes only. It receives no
// expected values or stimulus authority and returns no executable pass criteria.
export const translatePlatformObservations = (input) => {
  if (
    !exactKeys(input, [
      "scenarioId",
      "modelRequests",
      "ingestionLedger",
      "retrievalLedger",
      "destinationObservation",
    ])
  )
    throw new Error("integration.fixture.adapter-observation");
  const {
    scenarioId,
    modelRequests,
    ingestionLedger,
    retrievalLedger,
    destinationObservation,
  } = input;
  if (
    typeof scenarioId !== "string" ||
    !scenarioIdPattern.test(scenarioId) ||
    !Array.isArray(modelRequests) ||
    modelRequests.length < 1 ||
    modelRequests.length > maximumEntries
  )
    throw new Error("integration.fixture.adapter-observation");
  return freeze({
    modelObservations: modelRequests.map(translateModelRequest),
    destinationLedger: {
      ledgerVersion: 1,
      scenarioId,
      ingestion: translateDestinationLedger(ingestionLedger, scenarioId),
      retrieval: translateDestinationLedger(retrievalLedger, scenarioId),
    },
    eventKindSets: translateEventObservation(
      destinationObservation,
      scenarioId,
    ),
  });
};
