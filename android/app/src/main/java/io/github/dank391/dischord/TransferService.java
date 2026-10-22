package io.github.dank391.dischord;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Keeps a file download or upload going while Dischord is in the background. Android freezes a backgrounded
 * app within seconds unless it runs a foreground service, which would stall the transfer until the user
 * came back. The service lasts from the transfer's start to its end and shows its progress.
 */
public final class TransferService extends Service {
    /** True while the transfer notification is in the foreground. */
    static boolean running;
    private static final String CHANNEL = "dischord_transfers";
    private static final int NOTIFICATION = 1203;
    private static final long LONGEST = 6 * 60 * 60 * 1000L; // Android's own daily limit for data transfers
    private PowerManager.WakeLock wake;

    /** Starts the service. Android only allows this while Dischord is on screen; elsewhere it is refused. */
    static boolean start(Context context, String text, int progress) {
        try {
            context.startForegroundService(new Intent(context, TransferService.class).putExtra("text", text).putExtra("progress", progress));
            return true;
        } catch (RuntimeException refused) { return false; }
    }
    /** Shows new progress on the running service's notification. */
    static void update(Context context, String text, int progress) {
        if (!running) return;
        context.getSystemService(NotificationManager.class).notify(NOTIFICATION, build(context, text, progress));
    }
    static void stop(Context context) { context.stopService(new Intent(context, TransferService.class)); }

    private static Notification build(Context context, String text, int progress) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager.getNotificationChannel(CHANNEL) == null)
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, "File transfers", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(context, 112, new Intent(context, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = new Notification.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("Dischord file transfer").setContentText(text == null || text.isEmpty() ? "Transferring a file" : text)
            .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).setCategory(Notification.CATEGORY_PROGRESS);
        if (progress >= 0 && progress <= 100) builder.setProgress(100, progress, false);
        return builder.build();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        Notification notification = build(this, intent.getStringExtra("text"), intent.getIntExtra("progress", -1));
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            else startForeground(NOTIFICATION, notification);
            running = true;
        } catch (RuntimeException error) { stopSelf(); return START_NOT_STICKY; }
        // The network keeps delivering with the screen off only if the CPU stays awake.
        if (wake == null) {
            wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Dischord:transfer");
            wake.setReferenceCounted(false);
        }
        wake.acquire(LONGEST);
        return START_NOT_STICKY;
    }
    // Android 15 stops data transfers that run longer than its daily limit.
    @Override public void onTimeout(int startId, int type) { stopSelf(); }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onDestroy() {
        running = false;
        if (wake != null && wake.isHeld()) wake.release();
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }
}
