function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const logger = {
  info: (...a) => console.log(`[${ts()}] INFO `, ...a),
  warn: (...a) => console.log(`[${ts()}] WARN `, ...a),
  error: (...a) => console.error(`[${ts()}] ERROR`, ...a),
};

module.exports = logger;