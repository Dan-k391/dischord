package io.github.dank391.dischord;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Looks at this repository's GitHub releases for a newer android-v* release and offers its APK. Download opens
 * the APK in the browser; Android then asks to install it over this version (same signing key).
 */
final class UpdateCheck {
    private static final String RELEASES = "https://api.github.com/repos/Dan-k391/dischord/releases?per_page=30";
    private final Activity activity;
    private boolean busy;
    private String offered = "";

    UpdateCheck(Activity activity) { this.activity = activity; }

    static boolean newer(String a, String b) {
        String[] x = a.split("\\."), y = b.split("\\.");
        if (x.length != 3 || y.length != 3) return false;
        try {
            for (int i = 0; i < 3; i++) {
                int p = Integer.parseInt(x[i]), q = Integer.parseInt(y[i]);
                if (p != q) return p > q;
            }
        } catch (NumberFormatException e) { return false; }
        return false;
    }

    /** manual: from Settings, always answers. Otherwise only a new version is mentioned, once per run. */
    void check(boolean manual) {
        if (busy) return;
        busy = true;
        new Thread(() -> {
            String version = null, apk = null, page = null;
            boolean failed = false;
            try {
                HttpURLConnection connection = (HttpURLConnection) new URL(RELEASES).openConnection();
                connection.setRequestProperty("Accept", "application/vnd.github+json");
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(15000);
                if (connection.getResponseCode() != 200) throw new IllegalStateException("GitHub answered " + connection.getResponseCode());
                JSONArray releases;
                try (InputStream input = connection.getInputStream()) {
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    byte[] buffer = new byte[8192]; int count;
                    while ((count = input.read(buffer)) != -1 && bytes.size() < 2_000_000) bytes.write(buffer, 0, count);
                    releases = new JSONArray(bytes.toString(StandardCharsets.UTF_8.name()));
                }
                for (int i = 0; i < releases.length(); i++) {
                    JSONObject release = releases.getJSONObject(i);
                    String tag = release.optString("tag_name");
                    if (!tag.matches("android-v\\d+\\.\\d+\\.\\d+") || release.optBoolean("draft") || release.optBoolean("prerelease")) continue;
                    String v = tag.substring("android-v".length());
                    if (version != null && !newer(v, version)) continue;
                    String url = null;
                    JSONArray assets = release.optJSONArray("assets");
                    for (int j = 0; assets != null && j < assets.length(); j++) {
                        JSONObject asset = assets.getJSONObject(j);
                        if ("Dischord-Android.apk".equals(asset.optString("name"))) url = asset.optString("browser_download_url");
                    }
                    version = v; apk = url; page = release.optString("html_url");
                }
            } catch (Exception error) { failed = true; }
            final String latest = version, download = apk != null ? apk : page;
            final boolean error = failed;
            activity.runOnUiThread(() -> {
                busy = false;
                if (activity.isFinishing() || activity.isDestroyed()) return;
                if (error || latest == null) {
                    if (manual) Toast.makeText(activity, "Could not check for updates. Check your connection and try again.", Toast.LENGTH_LONG).show();
                    return;
                }
                if (!newer(latest, BuildConfig.VERSION_NAME)) {
                    if (manual) Toast.makeText(activity, "Dischord is up to date (version " + BuildConfig.VERSION_NAME + ").", Toast.LENGTH_LONG).show();
                    return;
                }
                if (!manual && latest.equals(offered)) return;
                offered = latest;
                new AlertDialog.Builder(activity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                    .setTitle("Dischord " + latest + " is available")
                    .setMessage("You have version " + BuildConfig.VERSION_NAME + ". Download the new version, then open it to install. Your profile and settings stay.")
                    .setPositiveButton("Download", (dialog, which) -> {
                        try { activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(download))); } catch (RuntimeException ignored) { }
                    })
                    .setNegativeButton("Later", null)
                    .show();
            });
        }, "dischord-update-check").start();
    }
}
