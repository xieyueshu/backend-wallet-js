function loadRoute(app, newVal){
  if(newVal){
    if(newVal == 'dashboard')
      app.change_route('/admin/dashboard')
    else if(newVal == 'wd_section')
      app.change_route('/admin/withdraw')
    else if(newVal == 'wd_transaction')
      app.change_route('/admin/withdraw/transactions')
    else if(newVal == 'wd_request')
      app.change_route('/admin/withdraw/requests')
    else if(newVal == 'asset')
      app.change_route('/admin/assets')
    else if(newVal == 'deposit')
      app.change_route('/admin/deposit')
    else if(newVal == 'sent')
      app.change_route('/admin/sent')
    else if(newVal == 'users')
      app.change_route('/admin/user')
  } else {
    app.change_route('/admin/dashboard')
  }
}

function add_commas(value, checker) {
  var total_amount = (Big(value).toFixed()).split(".");
  total_amount[0] = total_amount[0].toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if(checker){
    return total_amount[0] + "." + (total_amount.length == 1 ? "00" : total_amount[1]);
  }
  return total_amount[0]
}