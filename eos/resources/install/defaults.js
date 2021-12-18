module.exports = {
  base: [
    {"name":"lastBlkNum", "value": 100000000}, 
    {"name":"lastBlkNumDnab", "value": 100000000}, 
    {"name":"lastBlkNumAtm", "value": 100000000}, 
    {"name":"lastBlkBtc", "value": 100000000}, 
    {"name": "exchangeRates", "USD": {}, "CNY": {}, "PHP": {}, "lastUpdated":""},
    {"name": "settings"}
  ],

  permission: [
    { "code" : "transferGas", "label" : "Trigger transfer of ETH for gas to deposit wallets" },
    { "code" : "transferCold", "label" : "Trigger transfer of tokens/ETH from deposit wallets to cold wallet" },
    { "code" : "updateRates", "label" : "Update coin rates manually" },
    { "code" : "viewWithdraw", "label" : "View withdrawal records" },
    { "code" : "viewDeposit", "label" : "View deposit records" },
    { "code" : "viewSent", "label" : "View sendfrom records" },
    { "code" : "viewUsers", "label" : "View user list" },
    { "code" : "viewWithdrawRequest", "label" : "View withdrawal requests" }
  ]
}