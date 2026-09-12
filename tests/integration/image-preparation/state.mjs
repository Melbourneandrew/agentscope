/** Private process-local lifecycle authority for the image-preparation facade. */
export const createImagePreparationState = () => {
  const preparedSets = new WeakSet();
  const preparedDockerClients = new WeakSet();
  const closingPreparedDockerClients = new WeakSet();
  const uncertainPreparedDockerClients = new WeakSet();
  const preparedDockerClientDiagnostics = new WeakMap();
  const pendingPreparedDockerImageRetirements = new WeakMap();

  const clientIsUsable = (client) =>
    preparedDockerClients.has(client) &&
    !closingPreparedDockerClients.has(client) &&
    !uncertainPreparedDockerClients.has(client);
  const pendingCount = (client) =>
    pendingPreparedDockerImageRetirements.get(client)?.size ?? 0;
  const recordDiagnostic = (client, diagnostic) =>
    preparedDockerClientDiagnostics.set(client, diagnostic);

  return Object.freeze({
    docker: Object.freeze({
      admitClient: (client) => preparedDockerClients.add(client),
      admitPreparedSet: (prepared) => preparedSets.add(prepared),
      clientIsUsable,
      hasDiagnostic: (client) => preparedDockerClientDiagnostics.has(client),
      markUncertain: (client) => uncertainPreparedDockerClients.add(client),
      pendingCount,
      readDiagnostic: (client) => preparedDockerClientDiagnostics.get(client),
      recordDiagnostic,
      recordPendingImage: (client, tag, imageId) =>
        pendingPreparedDockerImageRetirements.set(
          client,
          new Map([[tag, imageId]]),
        ),
    }),
    evidence: Object.freeze({
      hasPreparedSet: (prepared) => preparedSets.has(prepared),
    }),
    retirement: Object.freeze({
      beginClose: (client) => closingPreparedDockerClients.add(client),
      clientIsClosing: (client) => closingPreparedDockerClients.has(client),
      clientIsUncertain: (client) => uncertainPreparedDockerClients.has(client),
      completePendingImage: (client, tag) =>
        pendingPreparedDockerImageRetirements.get(client)?.delete(tag),
      endClose: (client) => closingPreparedDockerClients.delete(client),
      finishClose: (client) => {
        pendingPreparedDockerImageRetirements.delete(client);
        preparedDockerClients.delete(client);
      },
      hasClient: (client) => preparedDockerClients.has(client),
      hasDiagnostic: (client) => preparedDockerClientDiagnostics.has(client),
      markUncertain: (client) => uncertainPreparedDockerClients.add(client),
      pendingCount,
      pendingImageId: (client, tag) =>
        pendingPreparedDockerImageRetirements.get(client)?.get(tag),
      recordDiagnostic,
    }),
  });
};
