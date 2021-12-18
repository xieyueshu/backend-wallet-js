const request = require('request-promise-native');

let call = async (method, params) => {
  let username = process.env.AMT_RPC_USER;
  let password = process.env.AMT_RPC_PASS;

  let options = {
    url: process.env.AMT_RPC_URL,
    method: "post",
    headers: {
      "content-type": "text/plain"
    },
    auth: {
      user: username,
      pass: password
    },
    body: JSON.stringify({
      "jsonrpc": "1.0",
      "id": "amberwallet-service",
      "method": method,
      "params": params
    })
  };

  try {
    return JSON.parse(await request(options));
  } catch (err) {
    throw err;
  }
}

module.exports = {
  call
}