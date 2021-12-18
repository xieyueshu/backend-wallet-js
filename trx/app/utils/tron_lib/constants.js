const TronWeb = require("tronweb");
const TronStation = require("tronstation");
const BigNumber = require("bignumber.js");

let tronWeb, tStation;
if(process.env.CHAIN_SUPPORT.includes("TRX")) {
  tronWeb = new TronWeb({fullHost: process.env.TRX_TRONGRID_API_URL});
  tStation = new TronStation(tronWeb);
} 

module.exports = {
  tronWeb,
  tStation,
  TRX_DECIMAL: new BigNumber(10).pow(6),
  ENERGY_REQ: new BigNumber(process.env.TRX_ENERGY_REQUIREMENT),
  TRC20_DECIMAL: new BigNumber(10).pow(process.env.TRX_CONTRACT_DECIMAL),
  BANDWIDTH_REQ: new BigNumber(process.env.TRX_BANDWIDTH_REQUIREMENT),
  COIN_TRANSFER_MIN: new BigNumber(process.env.TRX_COIN_TRANSFER_MIN || "0"),
};