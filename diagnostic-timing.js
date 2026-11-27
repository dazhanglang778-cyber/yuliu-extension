(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.YuliuDiagnosticTiming = api;
})(globalThis, function () {
  // Never use updatedAt: navigation, reading and closing also update a session.
  function initialAnswer(session) {
    const events = session.events || [];
    const answer = events.find(e => e.type === 'answer_displayed' && e.data?.mode === 'initial');
    if (!answer) return { ms: null, estimated: false };
    const measured = answer.data?.responseElapsedMs;
    if (Number.isFinite(measured) && measured >= 0) return { ms: measured, estimated: false };
    const start = events.find(e => e.type === 'request_started' && e.requestId === answer.requestId);
    if (!start || !Number.isFinite(answer.at) || !Number.isFinite(start.at) || answer.at < start.at)
      return { ms: null, estimated: false };
    return { ms: answer.at - start.at, estimated: true };
  }
  return { initialAnswer };
});
