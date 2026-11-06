package com.test19124.charging;

import org.json.JSONObject;

/** 一个充电区的最新状态。 */
public class Area {
    public String id = "";
    public String name = "";
    public String address = "";
    public int total = 0;
    public int idle = 0;
    public int charging = 0;
    public int fault = 0;

    public JSONObject toJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("id", id);
            o.put("name", name);
            o.put("address", address);
            o.put("total", total);
            o.put("idle", idle);
            o.put("charging", charging);
            o.put("fault", fault);
        } catch (Exception ignored) {
        }
        return o;
    }

    public static Area fromJson(JSONObject o) {
        Area a = new Area();
        a.id = o.optString("id", "");
        a.name = o.optString("name", "");
        a.address = o.optString("address", "");
        a.total = o.optInt("total", 0);
        a.idle = o.optInt("idle", 0);
        a.charging = o.optInt("charging", 0);
        a.fault = o.optInt("fault", 0);
        return a;
    }
}
