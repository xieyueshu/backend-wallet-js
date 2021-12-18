// Oct 09 2020 (danie) - created erc20 lib
const fs = require("fs");
const Web3 = require("web3");

const WEB3_PROVIDER = new Web3.providers.HttpProvider(process.env.NODE_ETH_NETWORK,parseInt(process.env.NODE_ETH_TIMEOUT),process.env.NODE_ETH_USER,process.env.NODE_ETH_PASS);

const web3 = new Web3(WEB3_PROVIDER);

// connect to the contract
var abiArray = JSON.parse(fs.readFileSync("resources/contract.json", "utf-8"));
var contract = web3.eth.contract(abiArray).at(process.env.ETH_CONTRACT_ADDRESS);

module.exports = {
  contract,
};