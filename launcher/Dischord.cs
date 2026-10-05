// Dischord desktop launcher: opens the hosted site in its own app window using the
// Chrome or Edge that is already installed, so it talks to the same servers as the website.
// Build: C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:winexe /out:dist\Dischord.exe launcher\Dischord.cs
using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
using Microsoft.Win32;

static class Dischord
{
    const string Url = "https://dan-k391.github.io/dischord/";

    static string AppPath(string exe)
    {
        foreach (var root in new[] { Registry.CurrentUser, Registry.LocalMachine })
        {
            using (var k = root.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" + exe))
            {
                var p = k == null ? null : k.GetValue(null) as string;
                if (!string.IsNullOrEmpty(p) && File.Exists(p)) return p;
            }
        }
        return null;
    }

    [STAThread]
    static void Main(string[] args)
    {
        // an invite link can be passed as the first argument
        var url = args.Length > 0 && args[0].StartsWith(Url, StringComparison.OrdinalIgnoreCase) ? args[0] : Url;
        var browser = AppPath("chrome.exe") ?? AppPath("msedge.exe");
        try
        {
            if (browser != null) Process.Start(browser, "--app=\"" + url + "\" --window-size=1280,800");
            else Process.Start(url); // no Chrome / Edge found: fall back to the default browser
        }
        catch (Exception e)
        {
            MessageBox.Show("Could not open Dischord:\n" + e.Message + "\n\nOpen " + Url + " in your browser instead.", "Dischord");
        }
    }
}
