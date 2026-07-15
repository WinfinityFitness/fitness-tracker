package io.github.winfinityfitness.twa;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;

// Bridges the WebView app's JS state (current exercise/timer, or GPS
// stats/path) to the two home-screen widgets (TrainingWidgetProvider /
// OutdoorWidgetProvider) — a widget can't run the app's own JS, so this is
// the only way their RemoteViews ever get fresh data. Called on every
// training-timer tick / GPS position update while the app process is
// alive (foreground or backgrounded) — see updateTrainingWidget/
// updateOutdoorWidget in app.js.
//
// Widget taps go the other way: MainActivity writes the tapped action
// (start/finishTraining, start/finishOutdoor) to "pending_widget_action" in
// the same SharedPreferences file (see onCreate/onNewIntent) rather than
// trying to eval JS directly — the WebView may not have finished loading
// yet on a cold start. getPendingWidgetAction() lets the JS side ask for
// it once ready (on initial load and on every visibilitychange), which
// works the same regardless of cold-start vs. resume-from-background.
@CapacitorPlugin(name = "WidgetBridge")
public class WidgetBridgePlugin extends Plugin {
    public static final String PREFS = "widget_bridge_prefs";

    @PluginMethod
    public void updateTrainingWidget(PluginCall call) {
        Context ctx = getContext();
        SharedPreferences.Editor editor = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        editor.putString("training_state", call.getString("state", "idle"));
        editor.putString("training_exercise", call.getString("exerciseName", ""));
        editor.putString("training_timer", call.getString("timerText", ""));
        editor.apply();
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, TrainingWidgetProvider.class));
        TrainingWidgetProvider.updateAll(ctx, mgr, ids);
        call.resolve();
    }

    @PluginMethod
    public void updateOutdoorWidget(PluginCall call) {
        Context ctx = getContext();
        SharedPreferences.Editor editor = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        editor.putString("outdoor_state", call.getString("state", "idle"));
        editor.putString("outdoor_steps", call.getString("steps", "0"));
        editor.putString("outdoor_pace", call.getString("paceKph", "0.0"));
        editor.putString("outdoor_distance", call.getString("distanceKm", "0.00"));
        String pathImageBase64 = call.getString("pathImageBase64", null);
        if (pathImageBase64 != null && !pathImageBase64.isEmpty()) {
            try {
                String pure = pathImageBase64.contains(",")
                        ? pathImageBase64.substring(pathImageBase64.indexOf(",") + 1)
                        : pathImageBase64;
                byte[] bytes = Base64.decode(pure, Base64.DEFAULT);
                Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (bmp != null) {
                    File f = new File(ctx.getFilesDir(), "outdoor_widget_path.png");
                    try (FileOutputStream out = new FileOutputStream(f)) {
                        bmp.compress(Bitmap.CompressFormat.PNG, 100, out);
                    }
                    editor.putString("outdoor_path_file", f.getAbsolutePath());
                }
            } catch (Exception ignored) {
                // Keep whatever path image was already saved rather than
                // blanking it out over one bad frame.
            }
        }
        editor.apply();
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, OutdoorWidgetProvider.class));
        OutdoorWidgetProvider.updateAll(ctx, mgr, ids);
        call.resolve();
    }

    @PluginMethod
    public void getPendingWidgetAction(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String action = prefs.getString("pending_widget_action", null);
        if (action != null) prefs.edit().remove("pending_widget_action").apply();
        JSObject ret = new JSObject();
        ret.put("action", action);
        call.resolve(ret);
    }
}
