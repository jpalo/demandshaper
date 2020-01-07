get_device_state_timeout = false

function load_device(device_id, device_name, device_type)
{
    device_loaded = true;
    $("#scheduler-outer").show();

    $("#devicename").html(jsUcfirst(device_name));
    $(".node-scheduler-title").html("<span class='icon-"+device_type+"'></span>"+device_name+" <span class='device-state-message'></span>");
    $(".node-scheduler").attr("node",device_name);

    if (device_type=="openevse") {
        $(".openevse").show();
        battery.init("battery");
        battery.draw();
        battery.events();
        $("#run_period").hide();
        $("#run_period").parent().addClass('span2').removeClass('span4');
        $("#mode button[mode='disabled']").show();        
    }
    else if (device_type=="hpmon") {
        $(".heatpumpmonitor").show();
    }
    
    // -------------------------------------------------------------------------
    // Defaults
    // -------------------------------------------------------------------------
    var default_schedule = {
        // Settings are persisted to mysql database
        settings: {
            device:device_name,
            device_type:device_type,
            ctrlmode:"smart", // on, off, smart, timer
            signal:"carbonintensity",
            // Smart mode
            period:3,
            end:8,
            interruptible:0,
            // Timer mode
            timer_start1:0,
            timer_stop1:0,
            timer_start2:0,
            timer_stop2:0,
            // Repetition
            repeat:[1,1,1,1,1,1,1],
            runonce:false,
            // hpmon
            flowT:30.0,
            // OpenEVSE
            batterycapacity: 20.0,
            chargerate: 3.8,
            ovms_vehicleid: '',
            ovms_carpass: '',
            ev_soc: 0.2,
            ev_target_soc: 0.8,
            ip: ''
        },
        // Runtime change often and are saved only to redis
        runtime: {
            periods: [],
            timeleft:3*3600,
            last_update_from_device:0
        }
    };
    var schedule = default_schedule;
    var forecast = false;
    var profile = false;
    var imatch = 1;
    var options = {};
    
    var resolution = 900;
    var resolution_hours = resolution / 3600;
    
    update_device();    
    
    if (schedule.settings.device_type=="openevse" || schedule.settings.device_type=="hpmon") {
        update_status();
        setInterval(update_status,5000);
        function update_status(){
            $.ajax({ url: emoncmspath+"input/get/"+device_name+apikeystr, dataType: 'json', async: true, success: function(result) {
                if (result!=null) {
                    if (result.amp!=undefined) $("#charge_current").html((result.amp.value*0.001).toFixed(1));
                    if (result.temp1!=undefined) $("#openevse_temperature").html((result.temp1.value*0.1).toFixed(1));
                    if (result.SNXflowT!=undefined) {
                         $("#heatpump_flowT").html((result.SNXflowT.value).toFixed(1));
                         if (schedule.settings.flowT==undefined) {
                             schedule.settings.flowT = result.SNXflowT.value;
                             $("#flowT input").val(result.SNXflowT.value.toFixed(1)+"C");
                         }
                    }
                    if (result.SNXheat!=undefined) $("#heatpump_heat").html((result.SNXheat.value).toFixed(0));
                }
            }});
        }
    }

    // -------------------------------------------------------------------------
    // Fetch device schedule, init view
    // -------------------------------------------------------------------------

    function update_device() {

        $.ajax({ url: emoncmspath+"demandshaper/get?device="+device_name+apikeystr, dataType: 'json', async: true, success: function(result) {
            // Make schedule object global
            if (result==null || result.schedule==null) {
                // invalid schedule, use default applied above        
            } else {
                
                schedule = default_schedule;
                
                if (result.schedule.settings!=undefined) {
                    for (var z in default_schedule.settings) {
                        if (result.schedule.settings[z]!=undefined) schedule.settings[z] = result.schedule.settings[z];
                    }
                }
                
                if (result.schedule.runtime!=undefined) {                
                    for (var z in default_schedule.runtime) {
                        if (result.schedule.runtime[z]!=undefined) schedule.runtime[z] = result.schedule.runtime[z];
                    }
                }
                
                schedule.settings.device = device_name;
                schedule.settings.device_type = device_type;
                
                // Load SOC
                if (schedule.settings.device_type=="openevse") {
                    battery.capacity = schedule.settings.batterycapacity;
                    battery.charge_rate = schedule.settings.chargerate;
                    battery.end_soc = schedule.settings.ev_target_soc;
                    if (schedule.settings.ovms_vehicleid!='' && schedule.settings.ovms_carpass!='') {
                        $.ajax({ url: emoncmspath+"demandshaper/ovms?vehicleid="+schedule.settings.ovms_vehicleid+"&carpass="+schedule.settings.ovms_carpass+apikeystr, dataType: 'json', async: true, success: function(result) {
                            schedule.settings.ev_soc = result.soc*0.01;
                            battery.soc = schedule.settings.ev_soc;
                            battery.draw();
                        }});
                    }
                }
            }
            
            get_forecast(schedule.settings.signal,calc_schedule);
        }});
    }
    
    function get_forecast(signal,callback) {
        $.ajax({ url: emoncmspath+"demandshaper/forecast?signal="+signal+apikeystr,
        dataType: 'json',
        async: true,
        success: function(result) {
            forecast = result;
            profile = forecast.profile;
            callback();
        }});    
    }
        
    // --------------------------------------------------------------------------------------------
    // Submits schedule for calculation
    // The schedule is submited without saving to start with assuming user is still changing schedule
    // After 1.9s of inactivity the schedule is autosaved.
    // --------------------------------------------------------------------------------------------
    function calc_schedule() {
        if (forecast && forecast.profile!=undefined) {
            draw_schedule();
            
            let js_calc = true;
            
            if (js_calc) {
                if (schedule.settings.ctrlmode=="smart") {
                    schedule.runtime.periods = schedule_smart(forecast,schedule.settings.period*3600,schedule.settings.end,schedule.settings.interruptible,resolution)
                } else if (schedule.settings.ctrlmode=="timer") {
                    schedule.runtime.periods = schedule_timer(forecast,schedule.settings.timer_start1,schedule.settings.timer_stop1,schedule.settings.timer_start2,schedule.settings.timer_stop2,resolution)
                } else {
                    schedule.runtime.periods = []
                }
                draw_schedule_output(schedule);
            }
            
            last_submit = (new Date()).getTime();
            setTimeout(function(){
                if (((new Date()).getTime()-last_submit)>1900) {
                    submit_schedule(1,function(result){
                        console.log("saved");
                        
                        // Check result
                        if (js_calc) {
                            if (JSON.stringify(result.schedule.runtime.periods)==JSON.stringify(schedule.runtime.periods)) { 
                                console.log("php js schedule match"); 
                            } else { 
                                console.log("php js schedule match error")
                                console.log("php: "+JSON.stringify(result.schedule.runtime.periods))
                                console.log("js:  "+JSON.stringify(schedule.runtime.periods))
                            }
                        } else {
                            schedule.runtime.periods = result.schedule.runtime.periods
                        }
                        
                        clearTimeout(get_device_state_timeout)
                        get_device_state_timeout = setTimeout(function(){ get_device_state(); },1000);
                    });
                }
            },2000);
        }
    }

    function submit_schedule(save,submit_callback) {
        $.ajax({ 
            method: 'POST',
            url: emoncmspath+"demandshaper/submit",
            data: "schedule="+JSON.stringify(schedule)+"&save="+save+apikeystr,
            dataType: 'json',
            async: true,
            success: function(result) {
                submit_callback(result);
            }
        });
    }

    // --------------------------------------------------------------------------------------------
    // Populates UI with schedule params        
    // --------------------------------------------------------------------------------------------
    function draw_schedule() {
        $("#mode button[mode="+schedule.settings.ctrlmode+"]").addClass('active').siblings().removeClass('active');
        if (schedule.settings.ctrlmode=="timer") { $(".smart").hide(); $(".timer").show(); $(".repeat").show(); }
        if (schedule.settings.ctrlmode=="smart") { $(".smart").show(); $(".timer").hide(); $(".repeat").show(); }
        if (schedule.settings.ctrlmode=="on") { $(".smart").hide(); $(".timer").hide(); $(".repeat").hide(); }
        if (schedule.settings.ctrlmode=="off") { $(".smart").hide(); $(".timer").hide(); $(".repeat").hide(); }
        if (schedule.settings.ctrlmode=="disabled") { $(".smart").hide(); $(".timer").hide(); $(".repeat").hide(); }
        
        // var elapsed = Math.round((new Date()).getTime()*0.001 - schedule.settings.last_update_from_device);
        // $("#last_update_from_device").html(elapsed+"s ago");
        
        if (schedule.settings.ip!="") $("#ip_address").html("IP Address: <a href='http://"+schedule.settings.ip+"'>"+schedule.settings.ip+"</a>");
        
        $("#period input[type=time]").val(timestr(schedule.settings.period,false));
        $("#end input[type=time]").val(timestr(schedule.settings.end,false));

        $("#timer_start1 input[type=time]").val(timestr(schedule.settings.timer_start1,false));
        $("#timer_stop1 input[type=time]").val(timestr(schedule.settings.timer_stop1,false));
        $("#timer_start2 input[type=time]").val(timestr(schedule.settings.timer_start2,false));
        $("#timer_stop2 input[type=time]").val(timestr(schedule.settings.timer_stop2,false));

        if (schedule.settings.flowT!=undefined) {
            $("#flowT input[type=text]").val(schedule.settings.flowT.toFixed(1)+"C");
        }
        
        for (var i=0; i<7; i++) {
            $(".weekly-scheduler[day="+i+"]").attr("val",schedule.settings.repeat[i]);
        }
        
        $(".scheduler-checkbox[name='interruptible']").attr("state",schedule.settings.interruptible);
        
        draw_forecast_category_select(); 
        draw_forecast_select(forecast_list[schedule.settings.signal].category);
        
        $(".forecast").val(schedule.settings.signal);
        $(".forecast-category").val(forecast_list[schedule.settings.signal].category);
                    
        if (schedule.settings.device_type=="openevse") {   
            $(".input[name=batterycapacity").val(schedule.settings.batterycapacity);
            $(".input[name=chargerate").val(schedule.settings.chargerate);
            $(".input[name=vehicleid").val(schedule.settings.ovms_vehicleid);
            $(".input[name=carpass").val(schedule.settings.ovms_carpass);
            battery.draw();
        }
    }

    // --------------------------------------------------------------------------------------------
    // Draw scheduler graph and period info 
    // --------------------------------------------------------------------------------------------    
    function draw_schedule_output(schedule)
    {  
        options = {
            xaxis: { 
                mode: "time", 
                timezone: "browser", 
                font: {size:12, color:"#666"}, 
                reserveSpace:false
            },
            yaxis: { 
                font: {size:12, color:"#666"}, 
                reserveSpace:false,
                min:0
            },
            grid: {
                show:true, 
                color:"#aaa",
                borderWidth:0,
                hoverable: true, 
                clickable: true
            },
            selection: { mode: "x" },
            touch: { pan: "x", scale: "x" }
        };
      
        // --------------------------------------------------------------------------------------------
        // Schedule summaries
        // --------------------------------------------------------------------------------------------
        var date = new Date();
            
        if (schedule.runtime.periods==undefined) schedule.runtime.periods = []
                      
        // Output schedule periods
        var periods = [];
        for (var z in schedule.runtime.periods) {
        
            date = (new Date(schedule.runtime.periods[z].start[0]*1000));
            let h1 = date.getHours();
            let m1 = date.getMinutes()/60;

            date = (new Date(schedule.runtime.periods[z].end[0]*1000));
            let h2 = date.getHours();
            let m2 = date.getMinutes()/60;
                    
            periods.push(timestr(h1+m1,true)+" to "+timestr(h2+m2,true));
        }
        var out = ""; 
        if (periods.length) {
            out = jsUcfirst(device_name)+" scheduled to run: <b>"+periods.join(", ")+"</b><br>";
        }
        $("#schedule-output").html(out);
        $("#timeleft").html(Math.round(schedule.runtime.timeleft/60)+" mins left to run");

        if (out=="") {
            $("#schedule-output").hide();
            $("#timeleft").hide();
        } else {
            $("#schedule-output").show();
            $("#timeleft").show();
        }
        
        // --------------------------------------------------------------------------------------------
        // Draw schedule graph
        // --------------------------------------------------------------------------------------------
        var periods = schedule.runtime.periods;
        
        var interval = 1800;
        interval = (profile[1][0]-profile[0][0])*0.001;

        // Calculate end timestamp
        let end_hour = Math.floor(schedule.settings.end);
        let end_minutes = (schedule.settings.end - end_hour)*60;
        
        date = new Date();
        now = date.getTime();
        date.setHours(end_hour,end_minutes,0,0);
        let end_timestamp = date.getTime();
        if (end_timestamp<now) end_timestamp+=3600*24*1000

        // Shade out time after end of schedule
        if (schedule.settings.ctrlmode!="timer") {
            var markings = [];
            if (periods.length) markings.push({ color: "rgba(0,0,0,0.1)", xaxis: { from: end_timestamp } });
            options.grid.markings = markings;
        }
        
        // Show bars if interval is 1800s
        var bars = true;
        //if (interval<1800) bars = false;
        
        if (bars) {
            options.bars = { show: true, barWidth:interval*1000*0.8, lineWidth:0 };
        } else {
            options.lines = {fill:true};
        }
        
        // Generate series for active and inactive slots
        var sum = 0;
        var sum_n = 0;
        var peak = 0;
        var active = 0;
        available = [];
        unavailable = [];
        
        for (var z in profile) {
            var time = profile[z][0];
            var value = profile[z][1];
            
            if (value>peak) peak = value;
            
            active = false;
            for (var p in periods) {
                if (time>=periods[p].start[0]*1000 && time<periods[p].end[0]*1000) active = true;
            }
            
            if (schedule.settings.ctrlmode=="on") active = true;
                
            if (active) { 
                available.push([time,value]); 
                sum += value; sum_n++;
                if (bars) value=null;
            } 
            unavailable.push([time,value]);
        }
        
        // Display CO2 in window
        var out = "";
        if (sum_n>0) {
            var mean = sum/sum_n;
            
            if (schedule.settings.signal=="carbonintensity") {
                var co2_km = (mean / 4.0) / 1.6;
                var prc = 100-(100*(co2_km / 130));
                if (device_type=="openevse") out = "Charge ";
                out += "CO2 intensity: "+Math.round(mean)+" gCO2/kWh"
                if (device_type=="openevse") {
                    out += ", "+Math.round(co2_km)+" gCO2/km, "+Math.round(prc)+"% <span title='Compared to 50 MPG Petrol car'>reduction</span>.";
                } else if (device_type=="hpmon") {
                    out += ", "+Math.round(mean/3.8)+" gCO2/kWh Heat @ COP 3.8";
                } else {
                    out += ", "+Math.round(100.0*(1.0-(mean/peak)))+"% reduction vs peak";
                }
            } else if (schedule.settings.signal.indexOf("octopus")==0 || schedule.settings.signal=="economy7") {

                if (device_type=="openevse") {
                    var p_per_mile = (mean / 4.0);
                    var prc = 100-(100*(p_per_mile / 10.0));
                    out = "Cost: "+(p_per_mile).toFixed(1)+"p/mile, "+Math.round(100.0*(1.0-(mean/peak)))+"% reduction vs peak"
                    
                } else if (device_type=="hpmon") {
                    out = ", "+Math.round(mean/3.8)+" p/kWh Heat @ COP 3.8";
                } else {
                    out = "Average cost: "+mean.toFixed(1)+"p/kWh, "+Math.round(100.0*(1.0-(mean/peak)))+"% reduction vs peak";
                }  
            } else {
                out = Math.round(100.0*(1.0-(mean/peak)))+"% reduction vs peak";  
            }
        }
        $("#schedule-co2").html(out);
        
        draw_graph();
    }

    function draw_graph() {
        var width = $("#placeholder_bound").width();
        if (width>0) {
            $("#placeholder").width(width);
            $.plot($('#placeholder'), [{data:available,color:"#ea510e",fill:1.0},{data:unavailable,color:"#888"}], options);
        }
    }

    // --------------------------------------------------------------------------------------------
    // Fetches the device state via http request
    // used to provide user feedback to confirm that schedule has been transfered to device
    // --------------------------------------------------------------------------------------------   
    function get_device_state() {
        $.ajax({ url: emoncmspath+"demandshaper/get-state?device="+device_name+apikeystr,
            dataType: 'json',
            async: true,
            success: function(result) {
            
                if (result==false) {
                    console.log("Unresponsive");
                    $(".device-state-message").html("Unresponsive");
                    $(".node-scheduler-title").css("background-color","#bbb");
                    $(".node-scheduler").css("background-color","#bbb");
                    
                    clearTimeout(get_device_state_timeout)
                    get_device_state_timeout = setTimeout(function(){ get_device_state(); },5000);
                } else {
                    state_matched = true;
                    
                    device_ctrl_mode = result.ctrl_mode.toLowerCase();
                    if (schedule.settings.ctrlmode!=device_ctrl_mode) state_matched = false;
                    if (schedule.settings.ctrlmode=="smart" && device_ctrl_mode=="timer") state_matched = true;
                    if (!state_matched) console.log(schedule.settings.ctrlmode+"!="+device_ctrl_mode)
                    
                    if (schedule.runtime.periods==undefined) schedule.runtime.periods = []
                    
                    if (schedule.settings.ctrlmode=="smart" || schedule.settings.ctrlmode=="timer") {
                        if (schedule.runtime.periods.length>0) {
                            if (schedule.runtime.periods[0].start[1].toFixed(3) != result.timer_start1.toFixed(3)) { 
                                state_matched = false; 
                                console.log(schedule.runtime.periods[0].start[1].toFixed(3)+"!="+result.timer_start1.toFixed(3)); 
                            }
                            if (schedule.runtime.periods[0].end[1].toFixed(3) != result.timer_stop1.toFixed(3)) { 
                                state_matched = false; 
                                console.log(schedule.runtime.periods[0].end[1].toFixed(3)+"!="+result.timer_stop1.toFixed(3)); 
                            }
                        }
                    }
                    //if (schedule.settings.timer_start2 != result.timer_start2) { state_matched = false; console.log(schedule.settings.timer_start2+"!="+result.timer_start2); }
                    //if (schedule.settings.timer_stop2 != result.timer_stop2) { state_matched = false; console.log(schedule.settings.timer_stop2+"!="+result.timer_stop2); }
                    
                    if (schedule.settings.device_type=="hpmon") {
                        schedule_voltage_output = Math.round((schedule.settings.flowT - 7.14)/0.0371);
                        if (schedule_voltage_output != result.voltage_output) state_matched = false;
                    }
                    
                    if (state_matched) {
                        console.log("device state matched");
                        $(".device-state-message").html("Saved");
                        setTimeout(function(){
                            $(".device-state-message").html("");
                        },2000);
                        $(".node-scheduler-title").css("background-color","#ea510e");
                        $(".node-scheduler").css("background-color","#ea510e");
                    } else {
                        console.log("device state mismatch");
                        $(".node-scheduler-title").css("background-color","#bbb");
                        $(".node-scheduler").css("background-color","#bbb");
                        $(".device-state-message").html("Settings Mismatch");
                        clearTimeout(get_device_state_timeout)
                        get_device_state_timeout = setTimeout(function(){ get_device_state(); },5000);
                    }
                }
            }
        });        
    }

    // -------------------------------------------------------------------------
    // Misc functions
    // -------------------------------------------------------------------------
    function jsUcfirst(string) {return string.charAt(0).toUpperCase() + string.slice(1);}

    function t(){};

    function timestr(hour,type){
        
        var h = Math.floor(hour);
        var m = Math.round((hour - h) * 60);
        if (h<10) h = "0"+h;
        if (m<10) m = "0"+m;
        var str = h+":"+m;
        
        if (type) {
            if (hour==0) str = "Midnight";
            else if (hour==12) str = "Noon";
            else if (h>12) {
                h = h - 12;
                str = h+":"+m+" p.m.";
            } else if (h<12) {
                str += " a.m.";
            }
        }
        return str;
    }

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------
    $(window).resize(function(){
        draw_graph();
    });
    
    $("#mode button").click(function() {
        schedule.settings.ctrlmode = $(this).attr("mode");
        $(this).addClass('active').siblings().removeClass('active');
        
        switch (schedule.settings.ctrlmode) {
          case "on":
            // if (schedule.settings.period==0) schedule.settings.period = last_period;
            // var now = new Date();
            // var now_hours = (now.getHours() + (now.getMinutes()/60));
            // schedule.settings.end = Math.round((now_hours+schedule.settings.period)/resolution_hours)*resolution_hours;
            $(this).addClass("green").siblings().removeClass('red').removeClass('green');
            break;
          case "off":
            $(this).addClass("red").siblings().removeClass('red').removeClass('green');
            break;
          case "disabled":
            $(this).addClass("red").siblings().removeClass('red').removeClass('green');
            break;            
          case "timer":
            // if (schedule.settings.period==0) schedule.settings.period = last_period;
            // if (schedule.settings.end==0) schedule.settings.end = 8.0;
            $(this).siblings().removeClass('red').removeClass('green');
            break;
          case "smart":
            $(this).siblings().removeClass('red').removeClass('green');
            break;
        }
        calc_schedule();
    });

    $(".input-time button").click(function() {
        //schedule.settings.ctrlmode = "smart";
        //$("#mode button[mode=smart]").addClass('active').siblings().removeClass('active');
        
        var name = $(this).parent().attr("id");
        var type = $(this).html();
        
        if (type=="+") {
            schedule.settings[name] += resolution_hours;
            if (schedule.settings[name]>(24.0-resolution_hours)) schedule.settings[name] = 0.0;    
        } else if (type=="-") {
            schedule.settings[name] -= resolution_hours;
            if (schedule.settings[name]<0.0) schedule.settings[name] = 24.0-resolution_hours;
        }
        calc_schedule();
    });

    $(".input-time input[type=time]").change(function() {
        //schedule.settings.ctrlmode = "smart";
        //$("#mode button[mode=smart]").addClass('active').siblings().removeClass('active');
        
        var name = $(this).parent().attr("id");
        var timestring = $(this).val();
        var parts = timestring.split(":");
        var hour = parseInt(parts[0])+(parseInt(parts[1])/60.0)
        hour = Math.round(hour/resolution_hours)*resolution_hours
        
        schedule.settings[name] = hour
        calc_schedule(); 
    });

    $(".input-temperature button").click(function() {
        var name = $(this).parent().attr("id");
        var type = $(this).html();
        
        if (type=="+") {
            schedule.settings[name] += 1.0;
        } else if (type=="-") {
            schedule.settings[name] -= 1.0;
        }
        calc_schedule();
    });

    $(".input-temperature input[type=text]").change(function() {
        var name = $(this).parent().attr("id");
        var tempstr = $(this).val();
        tempstr = tempstr.replace("C","");
        schedule.settings[name] = parseFloat(tempstr);
        calc_schedule(); 
    });

    $(".scheduler-checkbox").click(function(){
        var name = $(this).attr('name');
        var state = 1; if ($(this).attr('state')==true) state = 0;
        
        $(this).attr("state",state);
        schedule.settings[name] = state;
        calc_schedule();
    });

    $(".weekly-scheduler").click(function(){
        var day = $(this).attr('day');
        var val = 1; if ($(this).attr('val')==1) val = 0;
        
        $(this).attr("val",val);
        schedule.settings.repeat[day] = val;
        calc_schedule();
    });

    $("#battery").on("bchange",function() { 
        battery.period = Math.round(battery.period/resolution_hours)*resolution_hours
        schedule.settings.period = battery.period
        schedule.settings.ev_target_soc = battery.end_soc
        schedule.runtime.timeleft = schedule.settings.period * 3600
        
        if (mode=="on") {
            var now = new Date();
            var now_hours = (now.getHours() + (now.getMinutes()/60));
            schedule.settings.end = Math.round((now_hours+schedule.settings.period)/resolution_hours)*resolution_hours;
        }
        calc_schedule();
    });

    $(".forecast-category").change(function(){
        let selected_forecast_category = $(this).val();
        draw_forecast_select(selected_forecast_category);
    });
    
    $(".forecast, .forecast-category").change(function(){
        // console.log($(".forecast-category").val()+" "+$(".forecast").val());
        schedule.settings.signal = $(".forecast").val();
        get_forecast(schedule.settings.signal,calc_schedule);        
    });

    $(".delete-device").click(function(){
        $("#DeleteDeviceModal").modal();
        $(".device-name").html(schedule.settings.device);
    });
    
    // ------------------------------------------------
    // openevse settings
    // ------------------------------------------------
    $(".input[name=batterycapacity").change(function(){
        var batterycapacity = $(this).val();
        schedule.settings.batterycapacity = batterycapacity*1.0;
        battery.capacity = schedule.settings.batterycapacity;
        calc_schedule();
    });

    $(".input[name=chargerate").change(function(){
        var chargerate = $(this).val();
        schedule.settings.chargerate = chargerate*1.0;
        battery.charge_rate = schedule.settings.chargerate;
        calc_schedule();
    });
    
    $(".input[name=vehicleid").change(function(){
        var vehicleid = $(this).val();
        schedule.settings.ovms_vehicleid = vehicleid;
        calc_schedule();
    });

    $(".input[name=carpass").change(function(){
        var carpass = $(this).val();
        schedule.settings.ovms_carpass = carpass;
        calc_schedule();
    });
    // ------------------------------------------------
    
    $("#delete-device-confirm").click(function(){
        schedule.settings.ctrlmode = "off";
        calc_schedule();
        // 1. Delete demandshaper schedule entry
        $.ajax({ url: path+"demandshaper/delete?device="+schedule.settings.device+apikeystr, async: true, success: function(data) {
            // 2. Delete device
            $.ajax({ url: path+"device/delete.json", data: "id="+device_id+apikeystr, async: true, success: function(data) {
                // 3. Delete device inputs
                $.ajax({ url: path+"input/list.json"+apikeystr, async: true, success: function(data) {
                    // get list of device inputs
                    var device_inputs = [];
                    for (var z in data) {
                       if (data[z].nodeid==schedule.settings.device) {
                          device_inputs.push(1*data[z].id);
                       }
                    }
                    console.log("Deleting inputs:");
                    console.log(device_inputs);
                    $.ajax({ url: path+"input/delete.json"+apikeystr, data: "inputids="+JSON.stringify(device_inputs), async: true, success: function(data){
                        location.href = emoncmspath+"demandshaper";
                    }});
                }});
            }});
        }});
    });
    
    // ----------------------------------------------------------------------------------------------------
    // Forecast selection
    // ----------------------------------------------------------------------------------------------------
    function draw_forecast_category_select() {
        let forecast_categories = [];
        for (let z in forecast_list) {
            if (forecast_categories.indexOf(forecast_list[z].category)==-1) {
                forecast_categories.push(forecast_list[z].category)
            }
        }

        let out = "";
        for (let z in forecast_categories) {
            out += "<option>"+forecast_categories[z]+"</option>";
        }
        $(".forecast-category").html(out);
    }

    function draw_forecast_select(selected_forecast_category) {
        let out = "";
        for (let z in forecast_list) {
            if (selected_forecast_category==forecast_list[z].category) {
                out += "<option value='"+z+"'>"+forecast_list[z].name+"</option>";
            }
        }
        $(".forecast").html(out);
    }
}
