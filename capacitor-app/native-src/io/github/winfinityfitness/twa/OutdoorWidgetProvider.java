package io.github.winfinityfitness.twa;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.widget.RemoteViews;

// Two states, driven by SharedPreferences written from
// WidgetBridgePlugin.updateOutdoorWidget (see the cardio GPS tick loop in
// app.js): "idle" (no tracking session running) renders as just a centered
// icon that starts one; "active" shows live steps/pace/distance plus a
// static snapshot bitmap of the tracked path so far (a widget can't host a
// real interactive map — the JS renders the path to a canvas and hands
// over a PNG each update instead).
public class OutdoorWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        updateAll(context, appWidgetManager, appWidgetIds);
    }

    public static void updateAll(Context context, AppWidgetManager mgr, int[] ids) {
        if (ids == null) return;
        SharedPreferences prefs = context.getSharedPreferences(WidgetBridgePlugin.PREFS, Context.MODE_PRIVATE);
        String state = prefs.getString("outdoor_state", "idle");
        for (int id : ids) {
            RemoteViews views;
            if ("active".equals(state)) {
                views = new RemoteViews(context.getPackageName(), R.layout.widget_outdoor_active);
                views.setTextViewText(R.id.widgetSteps, prefs.getString("outdoor_steps", "0") + " steps");
                views.setTextViewText(R.id.widgetPace, prefs.getString("outdoor_pace", "0.0") + " km/h");
                views.setTextViewText(R.id.widgetDistance, prefs.getString("outdoor_distance", "0.00") + " km");
                String pathFile = prefs.getString("outdoor_path_file", null);
                if (pathFile != null) {
                    Bitmap bmp = BitmapFactory.decodeFile(pathFile);
                    if (bmp != null) views.setImageViewBitmap(R.id.widgetPathImage, bmp);
                }
                views.setOnClickPendingIntent(R.id.widgetFinishIcon, actionIntent(context, "finishOutdoor", id));
            } else {
                views = new RemoteViews(context.getPackageName(), R.layout.widget_icon_only);
                views.setImageViewResource(R.id.widgetIcon, R.drawable.widget_icon_start);
                views.setOnClickPendingIntent(R.id.widgetIcon, actionIntent(context, "startOutdoor", id));
            }
            mgr.updateAppWidget(id, views);
        }
    }

    private static PendingIntent actionIntent(Context context, String action, int widgetId) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra("widget_action", action);
        return PendingIntent.getActivity(context, (action + widgetId).hashCode(), intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
