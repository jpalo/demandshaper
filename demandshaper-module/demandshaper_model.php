<?php

/*
     All Emoncms code is released under the GNU Affero General Public License.
     See COPYRIGHT.txt and LICENSE.txt.

     ---------------------------------------------------------------------
     Emoncms - open source energy visualisation
     Part of the OpenEnergyMonitor project:
     http://openenergymonitor.org

*/

// no direct access
defined('EMONCMS_EXEC') or die('Restricted access');

class DemandShaper
{
    private $mysqli;
    private $redis;
    private $log;
    
    public function __construct($mysqli,$redis)
    {
        $this->log = new EmonLogger(__FILE__);
        $this->mysqli = $mysqli;
        $this->redis = $redis;
    }
    
    public function get_list($device,$userid) {
        $devices_all = $device->get_list($userid);
        $devices = array();
        foreach ($devices_all as $d) {
            $name = $d["nodeid"];
            if (in_array($d['type'],array("openevse","smartplug","hpmon","wifirelay")))
                $devices[$name] = array("id"=>$d["id"]*1,"type"=>$d["type"]);
        }
        foreach ($devices_all as $d) {
            $name = $d["nodeid"];
            if (in_array($d['type'],array("emonth")))
                $devices[$name] = array("id"=>$d["id"]*1,"type"=>$d["type"]);
        }
        return $devices;
    }
    
    public function set($userid,$schedules)
    {
        // Basic validation
        $userid = (int) $userid;
        
        if ($schedules_old = $this->redis->get("demandshaper:schedules")) {
            $schedules_old = json_decode($schedules_old);
        }
        $this->redis->set("demandshaper:schedules",json_encode($schedules));
        
        // remove runtime settings
        $schedules_to_disk = json_decode(json_encode($schedules));
        foreach ($schedules_to_disk as $device=>$schedule) {
            unset($schedules_to_disk->$device->runtime);
        }
        
        // remove runtime settings
        $last_schedules_to_disk = $schedules_old;
        foreach ($last_schedules_to_disk as $device=>$schedule) {
            unset($last_schedules_to_disk->$device->runtime);
        }
        
        if (json_encode($schedules_to_disk)!=json_encode($last_schedules_to_disk)) {
        
            $schedules_to_disk = json_encode($schedules_to_disk);
        
            $result = $this->mysqli->query("SELECT `userid` FROM demandshaper WHERE `userid`='$userid'");
            if ($result->num_rows) {
                $stmt = $this->mysqli->prepare("UPDATE demandshaper SET `schedules`=? WHERE `userid`=?");
                $stmt->bind_param("si",$schedules_to_disk,$userid);
                if (!$stmt->execute()) {
                    return array('success'=>false, 'message'=>"Error saving demandshaper settings");
                }
                $this->log->error("Saved to disk");
                return array('success'=>true, 'message'=>"Saved to disk");
                
            } else {
                $stmt = $this->mysqli->prepare("INSERT INTO demandshaper (`userid`,`schedules`) VALUES (?,?)");
                $stmt->bind_param("is", $userid,$schedules_to_disk);
                if (!$stmt->execute()) {
                    return array('success'=>false, 'message'=>"Error saving demandshaper settings");
                }
                $this->log->error("Saved to disk");
                return array('success'=>true, 'message'=>"Saved to disk");
            }
        }
        $this->log->info("Saved to redis only");
        return array('success'=>true, 'message'=>"Saved to redis only");
    }
    
    public function get($userid)
    {
        $userid = (int) $userid;
        
        // Attempt first to load from cache
        $schedulesjson = $this->redis->get("demandshaper:schedules");
        
        if ($schedulesjson) {
            $schedules = json_decode($schedulesjson);
        } else {
            // Load from mysql
            $result = $this->mysqli->query("SELECT schedules FROM demandshaper WHERE `userid`='$userid'");
            if ($row = $result->fetch_object()) {
                $schedules = json_decode($row->schedules);
                foreach ($schedules as $device=>$schedule) {
                    $schedules->$device->runtime = new stdClass();
                    $schedules->$device->runtime->timeleft = 0;
                    $schedules->$device->runtime->periods = array();
                }
                $this->redis->set("demandshaper:schedules",json_encode($schedules));
            } else {
                $schedules = new stdClass();
            }
        }
        
        if (!$schedules || !is_object($schedules)) $schedules = new stdClass();
        
        foreach ($schedules as $device=>$schedule) {
            if (!isset($schedules->$device->runtime)) {
                $schedules->$device->runtime = new stdClass();
                $schedules->$device->runtime->timeleft = 0;
                $schedules->$device->runtime->periods = array();
            }
        }        
        
        
        return $schedules;
    }
    
    public function get_forecast_list() {
        return array(
            // General
            "carbonintensity"=>array("category"=>"General","name"=>"Carbon Intensity","resolution"=>1800),
            // Octopus Agile
            "octopusagile_A"=>array("category"=>"Octopus Agile","name"=>"Eastern England","resolution"=>1800),
            "octopusagile_B"=>array("category"=>"Octopus Agile","name"=>"East Midlands","resolution"=>1800),
            "octopusagile_C"=>array("category"=>"Octopus Agile","name"=>"London","resolution"=>1800),
            "octopusagile_D"=>array("category"=>"Octopus Agile","name"=>"Merseyside and Northern Wales","resolution"=>1800),
            "octopusagile_E"=>array("category"=>"Octopus Agile","name"=>"West Midlands","resolution"=>1800),
            "octopusagile_F"=>array("category"=>"Octopus Agile","name"=>"North Eastern England","resolution"=>1800),
            "octopusagile_G"=>array("category"=>"Octopus Agile","name"=>"North Western England","resolution"=>1800),
            "octopusagile_H"=>array("category"=>"Octopus Agile","name"=>"Southern England","resolution"=>1800),
            "octopusagile_J"=>array("category"=>"Octopus Agile","name"=>"South Eastern England","resolution"=>1800),
            "octopusagile_K"=>array("category"=>"Octopus Agile","name"=>"Southern Wales","resolution"=>1800),
            "octopusagile_L"=>array("category"=>"Octopus Agile","name"=>"South Western England","resolution"=>1800),
            "octopusagile_M"=>array("category"=>"Octopus Agile","name"=>"Yorkshire","resolution"=>1800),
            "octopusagile_N"=>array("category"=>"Octopus Agile","name"=>"Southern Scotland","resolution"=>1800),
            "octopusagile_P"=>array("category"=>"Octopus Agile","name"=>"Northern Scotland","resolution"=>1800),
            // Energy Local bethesda
            "energylocal_bethesda"=>array("category"=>"Energy Local","name"=>"Bethesda","resolution"=>1800),
            // Nordpool Spot
            "nordpool_fi"=>array("category"=>"Nordpool Spot","name"=>"FI","resolution"=>3600)
        );
    }
}
