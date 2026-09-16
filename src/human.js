const { config } = require('./config');

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout(promise, ms, fallback = null) {
  let timer;
  const timeout = new Promise((r) => {
    timer = setTimeout(() => r(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function typingDelay(textLen) {
  return rand(1200, Math.min(config.maxReplyDelay, 1000 + textLen * 12));
}

module.exports = { rand, sleep, withTimeout, typingDelay };