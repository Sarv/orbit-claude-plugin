// One error type for everything a tool can report back to Claude. `kind` says what happened:
//   not_connected — no Orbit connection; a browser sign-in has been started (message says so)
//   forbidden     — 403: not allowed in this project
//   not_found     — 404 / unknown key
//   invalid       — the tool's own input made no sense (bad URL, unknown state name…)
//   rate_limited  — 429 even after waiting once
//   failed        — Orbit answered with an error: the request definitely did not happen
//   unknown       — no answer (timeout, network, 502/503/504): it may or may not have happened
export class OrbitError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'OrbitError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}
