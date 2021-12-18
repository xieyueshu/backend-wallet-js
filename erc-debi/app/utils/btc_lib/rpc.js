const request = require("request-promise-native");

let call = async (method, params) => {
  let username = process.env.BTC_RPC_USER;
  let password = process.env.BTC_RPC_PASS;

  let options = {
    url: process.env.BTC_RPC_URL,
    method: "post",
    headers: {
      "content-type": "text/plain"
    },
    auth: {
      user: username,
      pass: password
    },
    body: JSON.stringify({
      "jsonrpc": "2.0",
      "id": "bitcoin-service",
      "method": method,
      "params": params
    })
  };

  // eslint-disable-next-line no-useless-catch
  try {
    return (JSON.parse(await request(options))).result;
  } catch (err) {
    throw err;
  }
};

module.exports = {
  call
};