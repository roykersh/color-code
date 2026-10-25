// osc.exe: writes OSC sequences to the console of the process that started it
// (Claude Code), so they reach that one Windows Terminal tab.
// Usage: osc.exe "11;#340c0c" "10;#f8f7f1" ...   each arg is one OSC body.
// Build: csc /nologo /target:exe /out:..\bin\osc.exe osc.cs
using System;
using System.Runtime.InteropServices;
using System.Text;

static class Osc {
    const uint ATTACH_PARENT_PROCESS = 0xFFFFFFFF;

    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool WriteConsoleW(IntPtr handle, string text, uint length, out uint written, IntPtr reserved);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    static int Main(string[] args) {
        if (args.Length == 0) return 2;
        uint pid = ATTACH_PARENT_PROCESS;
        int first = 0;
        if (args[0].StartsWith("--pid=")) { pid = uint.Parse(args[0].Substring(6)); first = 1; }

        var sb = new StringBuilder();
        for (int i = first; i < args.Length; i++) sb.Append("\x1b]").Append(args[i]).Append("\x1b\\");
        string text = sb.ToString();

        // Without --pid, climb the parents to the nearest one whose console
        // has VT output on: Claude Code's, in its Windows Terminal tab.
        uint self = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
        uint[] chain = pid == ATTACH_PARENT_PROCESS ? Ancestors(self) : new[] { pid };
        FreeConsole();
        foreach (uint candidate in chain) {
            if (!AttachConsole(candidate)) continue;
            IntPtr h = CreateFileW("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
            uint mode;
            if (GetConsoleMode(h, out mode) && (mode & 4) != 0) {
                uint written;
                bool ok = WriteConsoleW(h, text, (uint)text.Length, out written, IntPtr.Zero);
                CloseHandle(h);
                FreeConsole();
                Console.Out.WriteLine("pid " + candidate + (ok ? " ok" : " write failed"));
                return ok ? 0 : 1;
            }
            CloseHandle(h);
            FreeConsole();
        }
        Console.Error.WriteLine("no VT console among " + string.Join(",", chain));
        return 1;
    }

    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleMode(IntPtr handle, out uint mode);
    [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref ProcessEntry entry);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessEntry {
        public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    static uint[] Ancestors(uint pid) {
        var parents = new System.Collections.Generic.Dictionary<uint, uint>();
        IntPtr snap = CreateToolhelp32Snapshot(2, 0);
        var entry = new ProcessEntry { dwSize = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
        if (Process32FirstW(snap, ref entry)) {
            do parents[entry.th32ProcessID] = entry.th32ParentProcessID; while (Process32NextW(snap, ref entry));
        }
        CloseHandle(snap);
        var chain = new System.Collections.Generic.List<uint>();
        uint at = pid;
        while (chain.Count < 8 && parents.TryGetValue(at, out at) && at != 0) chain.Add(at);
        return chain.ToArray();
    }
}
