package io.github.winfinityfitness.twa;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;

// Three states, driven entirely by SharedPreferences written from
// WidgetBridgePlugin.updateTrainingWidget (see initTrainingWidgetSync in
// app.js): "idle" (no session today) and "cooldown" (resting between sets)
// both render as just a centered icon — tapping it starts or finishes the
// session respectively; "active" (a set is actively in progress) shows the
// current exercise name and timer text live.
public class TrainingWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        updateAll(context, appWidgetManager, appWidgetIds);
    }

    public static void updateAll(Context context, AppWidgetManager mgr, int[] ids) {
        if (ids == null) return;
        SharedPreferences prefs = context.getSharedPreferences(WidgetBridgePlugin.PREFS, Context.MODE_PRIVATE);
        String state = prefs.getString("training_state", "idle");
        for (int id : ids) {
            RemoteViews views;
            if ("active".equals(state)) {
                views = new RemoteViews(context.getPackageName(), R.layout.widget_training_active);
                views.setTextViewText(R.id.widgetExerciseName, prefs.getString("training_exercise", ""));
                views.setTextViewText(R.id.widgetTimerText, prefs.getString("training_timer", ""));
                views.setOnClickPendingIntent(R.id.widgetFinishIcon, actionIntent(context, "finishTraining", id));
            } else {
                boolean idle = !"cooldown".equals(state);
                views = new RemoteViews(context.getPackageName(), R.layout.widget_icon_only);
                views.setImageViewResource(R.id.widgetIcon, idle ? R.drawable.widget_icon_start : R.drawable.widget_icon_finish);
                views.setOnClickPendingIntent(R.id.widgetIcon, actionIntent(context, idle ? "startTraining" : "finishTraining", id));
            }
            mgr.updateAppWidget(id, views);
        }
    }

    // Launches (or resumes, via singleTask) MainActivity carrying the
    // tapped action — see MainActivity.onCreate/onNewIntent, which stashes
    // it for the JS side to pick up (see WidgetBridgePlugin.getPendingWidgetAction).
    private static PendingIntent actionIntent(Context context, String action, int widgetId) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra("widget_action", action);
        // Request code includes the widget id so multiple widget instances'
        // PendingIntents don't collapse into one (extras alone don't affect
        // PendingIntent identity).
        return PendingIntent.getActivity(context, (action + widgetId).hashCode(), intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
