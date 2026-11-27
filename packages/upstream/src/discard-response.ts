export const discardUpstreamResponse = async (response: Response): Promise<void> => {
  await response.body?.cancel();
};
