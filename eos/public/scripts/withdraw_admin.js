new Vue({
        el: '#q-app',
        data: function () {
          return {
            filter: 'amtc',
            drawerState: true,
            tab_status: 'completed',
            columns_transaction: [
              { name: '_id', label: 'id', align: 'left', field: '_id', sortable: true },
              { name: 'recepient', required: true, label: '地址 Address', align: 'left', field: 'recepient', sortable: true },
              { name: 'amount', required: true, label: '金额 Amount', align: 'left', field: 'amount', sortable: true, 
                format:function(value, row){ var total_amount = (Big(value).toFixed()).split("."); total_amount[0] = total_amount[0].toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
                return total_amount[0] + "." + (total_amount.length == 1 ? "00" : total_amount[1]); }, sort: (a,b) => parseFloat(a) - parseFloat(b) },
              { name: 'txnHash', required: true, label: '交易哈希 Transaction Hash', align: 'left', field: 'txnHash', sortable: true },
              { name: 'createTime', label: '建立时间 Creation Time', align: 'left', field: 'createTime', sortable: true, format:function(value, row){ return new Date(value).toLocaleString();} }
            ],
            columns_requests: [ 
              { name: '_id', label: 'id', align: 'left', field: '_id', sortable: true },
              { name: 'totalAmount', required: true, label: '总金额 Total Amount', align: 'left', field: 'totalAmount', sortable: true,
                format:function(value, row){ var total_amount = (Big(value).toFixed()).split("."); total_amount[0] = total_amount[0].toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
                return total_amount[0] + "." + (total_amount.length == 1 ? "00" : total_amount[1]); }, sort: (a,b) => parseFloat(a) - parseFloat(b)  },
              { name: 'estimateGas', required: true, label: '预估gas Estimated Gas', align: 'left', field: 'estimateGas', sortable: true,
                format:function(value, row){ var total_amount = (Big(value).toFixed()).split("."); total_amount[0] = total_amount[0].toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
                return total_amount[0] + "." + (total_amount.length == 1 ? "00" : total_amount[1]); }, sort: (a,b) => parseFloat(a) - parseFloat(b)  },
              { name: 'createDt', label: '建立时间 Creation Time', align: 'left', field: 'createDt', sortable: true, format:function(value, row){ return new Date(value).toLocaleString();} },
              { name: 'transactions',required: true, label: '细节 Details', align: 'left', field: 'transactions',
                format:function(value, row){ var result=""; for (var i=0;i<value.length;i++){ result+=value[i].requestAddr + ", " + value[i].amount+";"; } return result;} }
            ],
            columns_sub_requests: [
              { name: 'requestAddr', label: '请求地址 Request Address', align: 'left', field: 'requestAddr', sortable: true },
              { name: 'amount', required: true, label: '金额 Amount', align: 'left', field: 'amount',
                format:function(value, row){ var total_amount = (Big(value).toFixed()).split("."); total_amount[0] = total_amount[0].toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
                return total_amount[0] + "." + (total_amount.length == 1 ? "00" : total_amount[1]); },sortable: true, sort: (a,b) => parseFloat(a) - parseFloat(b) }
            ],
            visible_transactions: ['recepient', 'amount', 'txnHash', 'createTime'],
            visible_requests: ['totalAmount', 'estimateGas', 'createDt', 'transactions'],
            visible_sub_requests: ['requestAddr', 'amount'],
            selected_transactions: [],
            selected_pending: [],
            selected_rejected: [],
            separator: 'horizontal',
            pagination_control: [{rowsPerPage: 10, page: 1}, {rowsPerPage: 10, page: 1}, {rowsPerPage: 10, page: 1}, 
                                 {rowsPerPage: 10, page: 1}, {rowsPerPage: 10, page: 1}, {rowsPerPage: 10, page: 1}, {rowsPerPage: 0, page: 1} ],
            completed: JSON.parse('<%- JSON.stringify(completed) %>'),
            failed: JSON.parse('<%- JSON.stringify(failed) %>'),
            pending: JSON.parse('<%- JSON.stringify(pending) %>'),
            pendingRequests: JSON.parse('<%- JSON.stringify(pendingRequests) %>'),
            approvedRequests: JSON.parse('<%- JSON.stringify(approvedRequests) %>'),              
            rejectedRequests: JSON.parse('<%- JSON.stringify(rejectedRequests) %>'),
            hot_wallet: 'loading...',
            hot_wallet_link: '',
            eth: 'loading...',
            amtc: 'loading...',
            withdraw_approval: null,
            password: '',
            chk: true,
            load_settings: true
            }
        },
        methods: {
          tab: function(id) {
              this.tab_status = id;
              if(id != "settings"){
               var self = this;
                    fetch(`/withdrawAdmin/?data=`+id)
                    .then(res => res.json())
                    .then(res => {
                        if(id=="completed") self.$data.completed = res;
                        else if(id=="failed") self.$data.failed = res;
                        else if(id=="pending") self.$data.pending = res;
                        else if(id=="pendingRequests") self.$data.pendingRequests = res;
                        else if(id=="approvedRequests") self.$data.approvedRequests = res;
                        else self.$data.rejectedRequests = res;
                    });
              }

              // One-time-pull of hot wallet, eth, and amtc values once the Withdraw Settings tab is displayed
              if(this.chk && id == "settings"){
                this.chk = false;
                fetch(`/getHotWallet`)
                .then(res => res.json())
                .then(res => {
                    this.hot_wallet = res["address"];
                    this.eth = res["eth"];
                    this.amtc = res["amtc"];
                    this.hot_wallet_link = res["walletLink"];
                    this.load_settings = false;
                });
            
                fetch(`/getSetting/?name=withdraw_approval`)
                .then(res => res.json())
                .then(res => {
                    this.withdraw_approval = res["WITHDRAW_APPROVAL"];
                });
              }
          },
          hot_wallet_page: function(e){
              if(this.load_settings) e.preventDefault();
          },
          create_array: function(arr){ // Creates an array of selected _ids
              var new_arr = [];
              for(var i = 0; i < arr.length; i++){
                  new_arr.push(arr[i]["_id"]);
              }
              return new_arr;
          },
          submit_settings: function(e){
              this.$q.loading.show()
              var self = this;
              $.post('/setSetting', $('#form_settings').serialize(), function (data, status, request) {
                setTimeout(function(){
                    self.$q.loading.hide();
                    if(data["error"])
                        self.$q.notify({ message: '失败 Failed!', timeout: 3000, type: 'negative', color: 'negative', textColor: 'white', position: 'top-right', detail: "提交提现设置 Submit Withdraw Settings"});
                    else
                        self.$q.notify({ message: '成功 Success!', timeout: 3000, type: 'positive', color: 'positive', textColor: 'white', position: 'top-right', detail: "提交提现设置 Submit Withdraw Settings"});
                    self.$data.password = "";
                }, 500);
              })
          },
          update_tables: function(){
              var self = this;
              
              setInterval(function(){
                fetch(`/withdrawAdmin/?data=get`)
                .then(res => res.json())
                .then(res => {
                    self.$data.completed = res["completed"];
                    self.$data.failed = res["failed"];
                    self.$data.pending = res["pending"];
                    self.$data.pendingRequests = res["pendingRequests"];
                    self.$data.approvedRequests = res["approvedRequests"];
                    self.$data.rejectedRequests = res["rejectedRequests"];
                });
              }, 30000);
          },
          calc_total: function(table, table_name){
              let total = [];
                  Object.entries(table).forEach(([key, val]) => {
                      if(table_name.indexOf("Requests") >= 0) total.push(parseFloat(val.totalAmount)) // the value of the current key.
                      else total.push(parseFloat(val.amount))
                  });
              var total_amount = (Big(total.reduce(function(total, num){ return total + num }, 0)).toFixed()).split(".");
              total_amount[0] = total_amount[0].toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
              return total_amount[0] + "." + (total_amount.length == 1 ? "00" : total_amount[1]);
          },
          process_requests: function(id, link, detail, tab){
              this.$q.loading.show()
              var data = null;
              if(id == 'rejected') data = this.selected_rejected;
              else if(id == 'pending') data = this.selected_pending;
              else if(id == 'failed') data = this.selected_transactions;
              
              var json_arr = (id == 'settings' ? $('#form_settings').serialize() : { data: this.create_array(data) });
              var self = this;
              $.post('/'+link, json_arr, function (data, status, request) {
                  setTimeout(function(){
                      self.$q.loading.hide();
                      if(data["error"]) self.$q.notify({ message: '失败 Failed!', timeout: 3000, type: 'negative', color: 'negative', textColor: 'white', position: 'top-right', detail: detail});
                      else self.$q.notify({ message: '成功 Success!', timeout: 3000, type: 'positive', color: 'positive', textColor: 'white', position: 'top-right', detail: detail});
                      
                      if(id == 'rejected') self.$data.selected_rejected = [];
                      else if(id == 'pending') self.$data.selected_pending = [];
                      else self.$data.password = "";
                      
                      self.tab(tab)
                  }, 500);
              });
          },
          change_theme: function(){
              alert(this.filter)
          }
        },
        computed: {
            total_completed: function(){
                return this.calc_total(this.completed, "completed")
            },
            total_failed: function(){
                return this.calc_total(this.failed, "failed")
            },
            total_pending: function(){
                return this.calc_total(this.pending, "pending")
            },
            total_pendingRequests: function(){
                return this.calc_total(this.pendingRequests, "pendingRequests")
            },
            total_approvedRequests: function(){
                return this.calc_total(this.approvedRequests, "approvedRequests")
            },
            total_rejectedRequests: function(){
                return this.calc_total(this.rejectedRequests, "rejectedRequests")
            },
            color: function(){
                return (this.filter == "amtc" ? "primary" : "secondary")
            }
        },
        beforeMount(){
            Quasar.i18n.set(Quasar.i18n.zhHans)
            this.update_tables()
        }
      })