// A response whose body is neither read nor cancelled keeps its transport
// alive: on the direct-connect egress the dialed socket is closed only from the
// body's own read-to-end or cancel path.
export const discardUpstreamResponse = async (response: Response): Promise<void> => {
  await response.body?.cancel();
};
