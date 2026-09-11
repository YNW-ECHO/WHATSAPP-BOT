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

function readDelay(textLen) {
  return rand(1200, Math.min(5500, 1500 + textLen * 18));
}

function typingDelay(textLen) {
  return rand(1200, Math.min(config.maxReplyDelay, 1000 + textLen * 12));
}

module.exports = { rand, sleep, withTimeout, readDelay, typingDelay };