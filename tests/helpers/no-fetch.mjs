// A preload (`node --import`) that reports and refuses every fetch: proof that a command made no
// request.
globalThis.fetch = async (url) => {
  process.stderr.write(`NETWORK ATTEMPT ${url}\n`);
  throw new Error('the network is off in tests');
};
