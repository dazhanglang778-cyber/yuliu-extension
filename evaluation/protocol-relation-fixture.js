// Only for existing scripted transport/position/format tests. This is NOT a
// semantic extractor or oracle, and must never be used by live-model evaluation.
// Those tests supply an aligned verdict; attribution tests author real frames
// explicitly instead. Do not count these stubs as model-quality evidence.
module.exports = function protocolRelationFixture(quote, evidenceId) {
  const subject = String(quote).trim().slice(0, 80);
  return { source: { subject, scope: "unspecified", qualifiers: [], subject_evidence_ids: [evidenceId] },
    claim: { subject: "协议测试中的主体占位符", scope: "unspecified", qualifiers: [] },
    subject_link: "explicit", preserves: { conditions: true, time: true, attribution: true } };
};
