// The pinned feature files are bound in place - the spec repo keeps the
// sentences, this repo owns the glue. Strict: an unbound or pending step
// fails the run.
export default {
  paths: [
    ".contracts/clients/specs/clients/features/*.feature",
    ".contracts/walks/specs/walks/features/*.feature",
  ],
  // TypeScript steps: run with NODE_OPTIONS=--import tsx (scripts/with-worker.mjs sets it).
  import: ["steps/**/*.ts"],
  format: ["progress"],
  strict: true,
  publish: false,
};
