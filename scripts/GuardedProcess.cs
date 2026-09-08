using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace TravelAgent
{
    public static class GuardedProcess
    {
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint CREATE_NO_WINDOW = 0x08000000;
        private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        private const uint STARTF_USESTDHANDLES = 0x00000100;
        private const uint HANDLE_FLAG_INHERIT = 0x00000001;
        private const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
        private const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const int JobObjectAssociateCompletionPortInformation = 7;
        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JOB_OBJECT_MSG_ACTIVE_PROCESS_LIMIT = 3;
        private const uint JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT = 9;
        private const uint JOB_OBJECT_MSG_JOB_MEMORY_LIMIT = 10;
        private const uint WAIT_OBJECT_0 = 0;
        private const uint WAIT_TIMEOUT = 258;
        private static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = new IntPtr(0x00020002);
        private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);

        public static int Run(
            string executable,
            string[] arguments,
            string workingDirectory,
            string projectRoot,
            int timeoutSeconds,
            int memoryLimitMB,
            int maxProcesses)
        {
            Mutex projectMutex = null;
            bool ownsMutex = false;
            IntPtr job = IntPtr.Zero;
            IntPtr completionPort = IntPtr.Zero;
            IntPtr process = IntPtr.Zero;
            IntPtr thread = IntPtr.Zero;
            IntPtr stdoutRead = IntPtr.Zero;
            IntPtr stdoutWrite = IntPtr.Zero;
            IntPtr stderrRead = IntPtr.Zero;
            IntPtr stderrWrite = IntPtr.Zero;
            IntPtr stdinRead = IntPtr.Zero;
            IntPtr stdinWrite = IntPtr.Zero;
            IntPtr attributeList = IntPtr.Zero;
            IntPtr inheritedHandleList = IntPtr.Zero;
            bool attributeListInitialized = false;
            PipePump stdoutPump = null;
            PipePump stderrPump = null;
            bool processCreated = false;
            bool processAssigned = false;
            bool timedOut = false;
            bool resourceViolation = false;
            ulong peakJobMemory = 0;

            try
            {
                ValidateInputs(
                    executable, arguments, workingDirectory, projectRoot,
                    timeoutSeconds, memoryLimitMB, maxProcesses);

                projectMutex = new Mutex(false, BuildMutexName(projectRoot));
                try
                {
                    ownsMutex = projectMutex.WaitOne(0);
                }
                catch (AbandonedMutexException)
                {
                    ownsMutex = true;
                }

                if (!ownsMutex)
                {
                    Console.Error.WriteLine("guard setup failed: another project command is active");
                    return 125;
                }

                MEMORYSTATUSEX memoryStatus = new MEMORYSTATUSEX();
                if (!GlobalMemoryStatusEx(memoryStatus))
                    throw NativeFailure("GlobalMemoryStatusEx");

                ulong requiredBytes = checked(((ulong)memoryLimitMB + 2048UL) * 1024UL * 1024UL);
                if (memoryStatus.ullAvailPhys < requiredBytes)
                {
                    Console.Error.WriteLine(
                        "guard setup failed: available physical memory {0} MiB; required {1} MiB",
                        memoryStatus.ullAvailPhys / (1024UL * 1024UL),
                        requiredBytes / (1024UL * 1024UL));
                    return 125;
                }

                job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero)
                    throw NativeFailure("CreateJobObject");

                JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                limits.BasicLimitInformation.LimitFlags =
                    JOB_OBJECT_LIMIT_JOB_MEMORY |
                    JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                limits.BasicLimitInformation.ActiveProcessLimit = (uint)maxProcesses;
                limits.JobMemoryLimit = new UIntPtr(checked((ulong)memoryLimitMB * 1024UL * 1024UL));
                SetJobInformation(job, JobObjectExtendedLimitInformation, limits);

                completionPort = CreateIoCompletionPort(InvalidHandleValue, IntPtr.Zero, UIntPtr.Zero, 1);
                if (completionPort == IntPtr.Zero)
                    throw NativeFailure("CreateIoCompletionPort");

                JOBOBJECT_ASSOCIATE_COMPLETION_PORT association = new JOBOBJECT_ASSOCIATE_COMPLETION_PORT
                {
                    CompletionKey = job,
                    CompletionPort = completionPort
                };
                SetJobInformation(job, JobObjectAssociateCompletionPortInformation, association);

                SECURITY_ATTRIBUTES pipeSecurity = new SECURITY_ATTRIBUTES();
                pipeSecurity.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
                pipeSecurity.bInheritHandle = true;
                if (!CreatePipe(out stdoutRead, out stdoutWrite, ref pipeSecurity, 0) ||
                    !SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0) ||
                    !CreatePipe(out stderrRead, out stderrWrite, ref pipeSecurity, 0) ||
                    !SetHandleInformation(stderrRead, HANDLE_FLAG_INHERIT, 0) ||
                    !CreatePipe(out stdinRead, out stdinWrite, ref pipeSecurity, 0) ||
                    !SetHandleInformation(stdinWrite, HANDLE_FLAG_INHERIT, 0))
                    throw NativeFailure("CreatePipe");

                STARTUPINFO startup = new STARTUPINFO();
                startup.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
                startup.dwFlags = STARTF_USESTDHANDLES;
                startup.hStdInput = stdinRead;
                startup.hStdOutput = stdoutWrite;
                startup.hStdError = stderrWrite;

                UIntPtr attributeListSize = UIntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeListSize);
                attributeList = Marshal.AllocHGlobal(checked((int)attributeListSize.ToUInt64()));
                if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeListSize))
                    throw NativeFailure("InitializeProcThreadAttributeList");
                attributeListInitialized = true;

                IntPtr[] inheritedHandles = { stdinRead, stdoutWrite, stderrWrite };
                inheritedHandleList = Marshal.AllocHGlobal(IntPtr.Size * inheritedHandles.Length);
                Marshal.Copy(inheritedHandles, 0, inheritedHandleList, inheritedHandles.Length);
                if (!UpdateProcThreadAttribute(
                    attributeList,
                    0,
                    PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                    inheritedHandleList,
                    new UIntPtr((uint)(IntPtr.Size * inheritedHandles.Length)),
                    IntPtr.Zero,
                    IntPtr.Zero))
                    throw NativeFailure("UpdateProcThreadAttribute");

                STARTUPINFOEX startupEx = new STARTUPINFOEX
                {
                    StartupInfo = startup,
                    lpAttributeList = attributeList
                };

                PROCESS_INFORMATION processInfo;
                StringBuilder commandLine = new StringBuilder(BuildCommandLine(executable, arguments));
                if (!CreateProcess(
                    executable,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                    IntPtr.Zero,
                    workingDirectory,
                    ref startupEx,
                    out processInfo))
                    throw NativeFailure("CreateProcess");

                processCreated = true;
                process = processInfo.hProcess;
                thread = processInfo.hThread;
                CloseHandleChecked(ref stdoutWrite);
                CloseHandleChecked(ref stderrWrite);
                CloseHandleChecked(ref stdinRead);
                CloseHandleChecked(ref stdinWrite);

                stdoutPump = new PipePump(ref stdoutRead, Console.OpenStandardOutput());
                stderrPump = new PipePump(ref stderrRead, Console.OpenStandardError());

                if (!AssignProcessToJobObject(job, process))
                    throw NativeFailure("AssignProcessToJobObject");
                processAssigned = true;

                if (ResumeThread(thread) == UInt32.MaxValue)
                    throw NativeFailure("ResumeThread");

                Stopwatch deadline = Stopwatch.StartNew();
                long timeoutMilliseconds = checked((long)timeoutSeconds * 1000L);
                while (true)
                {
                    DrainJobMessages(completionPort, ref resourceViolation, 64);
                    if (resourceViolation)
                    {
                        if (!TerminateJobObject(job, 126))
                            throw NativeFailure("TerminateJobObject");
                        WaitForProcessBounded(process, 5000);
                        break;
                    }
                    uint wait = WaitForSingleObject(process, 50);
                    if (wait == WAIT_OBJECT_0)
                        break;
                    if (wait != WAIT_TIMEOUT)
                        throw NativeFailure("WaitForSingleObject");
                    if (deadline.ElapsedMilliseconds >= timeoutMilliseconds)
                    {
                        timedOut = true;
                        if (!TerminateJobObject(job, 124))
                            throw NativeFailure("TerminateJobObject");
                        WaitForProcessBounded(process, 5000);
                        break;
                    }
                }

                DrainJobMessages(completionPort, ref resourceViolation, 64);
                if (resourceViolation && !timedOut)
                {
                    if (!TerminateJobObject(job, 126))
                        throw NativeFailure("TerminateJobObject");
                    WaitForProcessBounded(process, 5000);
                }
                peakJobMemory = QueryPeakJobMemory(job);

                uint childExitCode;
                if (!GetExitCodeProcess(process, out childExitCode))
                    throw NativeFailure("GetExitCodeProcess");

                // Closing the kill-on-close Job ends descendants left after the root exits.
                CloseHandleChecked(ref job);
                WaitForPumps(stdoutPump, stderrPump, 5000);

                if (timedOut)
                {
                    Console.Error.WriteLine("guard timeout after {0} seconds", timeoutSeconds);
                    return 124;
                }
                if (resourceViolation)
                {
                    Console.Error.WriteLine(
                        "guard resource limit reached; peak job memory {0} MiB",
                        peakJobMemory / (1024UL * 1024UL));
                    return 126;
                }
                return unchecked((int)childExitCode);
            }
            catch (Exception error)
            {
                bool cleanupFailed = error is TimeoutException || error is AggregateException;
                if (processCreated)
                {
                    if (processAssigned && job != IntPtr.Zero)
                    {
                        if (!TerminateJobObject(job, 125))
                            cleanupFailed = true;
                        if (WaitForSingleObject(process, 5000) != WAIT_OBJECT_0)
                            cleanupFailed = true;
                    }
                    else if (process != IntPtr.Zero)
                    {
                        if (!TerminateProcess(process, 125))
                            cleanupFailed = true;
                        if (WaitForSingleObject(process, 5000) != WAIT_OBJECT_0)
                            cleanupFailed = true;
                    }
                }
                Console.Error.WriteLine(
                    cleanupFailed ? "guard cleanup failed" : "guard setup failed");
                return 125;
            }
            finally
            {
                CloseHandleChecked(ref stdoutWrite);
                CloseHandleChecked(ref stderrWrite);
                CloseHandleChecked(ref stdinRead);
                CloseHandleChecked(ref stdinWrite);
                CloseHandleChecked(ref job);
                StopPumpsBounded(stdoutPump, stderrPump, 1000);
                CloseHandleChecked(ref thread);
                CloseHandleChecked(ref process);
                CloseHandleChecked(ref completionPort);
                CloseHandleChecked(ref stdoutRead);
                CloseHandleChecked(ref stderrRead);
                if (attributeListInitialized)
                    DeleteProcThreadAttributeList(attributeList);
                if (attributeList != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(attributeList);
                }
                if (inheritedHandleList != IntPtr.Zero)
                    Marshal.FreeHGlobal(inheritedHandleList);
                if (ownsMutex && projectMutex != null)
                    projectMutex.ReleaseMutex();
                if (projectMutex != null)
                    projectMutex.Dispose();
            }
        }

        private static string BuildMutexName(string projectRoot)
        {
            string canonicalRoot = Path.GetFullPath(projectRoot)
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                .ToUpperInvariant();
            using (SHA256 sha = SHA256.Create())
            {
                byte[] digest = sha.ComputeHash(Encoding.UTF8.GetBytes(canonicalRoot));
                StringBuilder name = new StringBuilder(@"Local\TravelAgent.GuardedExecution.");
                for (int i = 0; i < digest.Length; i++)
                    name.Append(digest[i].ToString("x2"));
                return name.ToString();
            }
        }

        private static void ValidateInputs(
            string executable,
            string[] arguments,
            string workingDirectory,
            string projectRoot,
            int timeoutSeconds,
            int memoryLimitMB,
            int maxProcesses)
        {
            if (String.IsNullOrWhiteSpace(executable) || executable.IndexOf('\0') >= 0)
                throw new ArgumentException();
            if (String.IsNullOrWhiteSpace(workingDirectory) || workingDirectory.IndexOf('\0') >= 0)
                throw new ArgumentException();
            if (String.IsNullOrWhiteSpace(projectRoot) || projectRoot.IndexOf('\0') >= 0)
                throw new ArgumentException();
            if (timeoutSeconds < 1 || timeoutSeconds > 600 ||
                memoryLimitMB < 64 || memoryLimitMB > 4096 ||
                maxProcesses < 1 || maxProcesses > 16)
                throw new ArgumentOutOfRangeException();
            if (arguments != null)
            {
                foreach (string argument in arguments)
                {
                    if (argument != null && argument.IndexOf('\0') >= 0)
                        throw new ArgumentException();
                }
            }
        }

        private static string BuildCommandLine(string executable, string[] arguments)
        {
            StringBuilder result = new StringBuilder(QuoteArgument(executable));
            foreach (string argument in arguments ?? Array.Empty<string>())
            {
                result.Append(' ');
                result.Append(QuoteArgument(argument ?? String.Empty));
            }
            return result.ToString();
        }

        // This is the inverse quoting convention consumed by CommandLineToArgvW.
        private static string QuoteArgument(string argument)
        {
            if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
                return argument;

            StringBuilder quoted = new StringBuilder("\"");
            int backslashes = 0;
            foreach (char character in argument)
            {
                if (character == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (character == '"')
                {
                    quoted.Append('\\', backslashes * 2 + 1);
                    quoted.Append('"');
                    backslashes = 0;
                    continue;
                }
                quoted.Append('\\', backslashes);
                backslashes = 0;
                quoted.Append(character);
            }
            quoted.Append('\\', backslashes * 2);
            quoted.Append('"');
            return quoted.ToString();
        }

        private sealed class PipePump
        {
            private readonly SafeFileHandle handle;
            private readonly object handleLock = new object();
            private volatile bool stopping;
            public readonly Task Completion;

            public PipePump(ref IntPtr rawHandle, Stream destination)
            {
                handle = new SafeFileHandle(rawHandle, true);
                rawHandle = IntPtr.Zero;
                try
                {
                    Completion = Task.Run(() =>
                    {
                        try
                        {
                            using (FileStream source = new FileStream(handle, FileAccess.Read, 16384, false))
                            {
                                byte[] buffer = new byte[16384];
                                while (!stopping)
                                {
                                    int count = source.Read(buffer, 0, buffer.Length);
                                    if (count == 0 || stopping)
                                        return;
                                    destination.Write(buffer, 0, count);
                                    if (stopping)
                                        return;
                                    destination.Flush();
                                }
                            }
                        }
                        catch (IOException)
                        {
                            if (!stopping)
                                throw;
                        }
                        finally
                        {
                            lock (handleLock)
                                handle.Dispose();
                        }
                    });
                }
                catch
                {
                    handle.Dispose();
                    throw;
                }
            }

            public void RequestStop()
            {
                stopping = true;
                lock (handleLock)
                {
                    // Cancellation does not wait, and can race with a new synchronous read.
                    // Only the worker disposes its handle, including after a cleanup timeout.
                    if (!handle.IsClosed)
                    {
                        try { CancelIoEx(handle, IntPtr.Zero); }
                        catch (ObjectDisposedException) { }
                    }
                }
            }
        }

        private static Task AllPumps(PipePump stdout, PipePump stderr)
        {
            return Task.WhenAll(
                stdout == null ? Task.CompletedTask : stdout.Completion,
                stderr == null ? Task.CompletedTask : stderr.Completion);
        }

        private static void WaitForPumps(PipePump stdout, PipePump stderr, int milliseconds)
        {
            if (!AllPumps(stdout, stderr).Wait(milliseconds))
                throw new TimeoutException("guard cleanup failed");
        }

        private static void StopPumpsBounded(PipePump stdout, PipePump stderr, int milliseconds)
        {
            if (stdout != null)
                stdout.RequestStop();
            if (stderr != null)
                stderr.RequestStop();
            // This is failure-path cleanup; never replace the existing failure with success.
            try { AllPumps(stdout, stderr).Wait(milliseconds); }
            catch (AggregateException) { }
        }

        private static void WaitForProcessBounded(IntPtr process, uint milliseconds)
        {
            uint wait = WaitForSingleObject(process, milliseconds);
            if (wait == WAIT_TIMEOUT)
                throw new TimeoutException("guard cleanup failed");
            if (wait != WAIT_OBJECT_0)
                throw NativeFailure("WaitForSingleObject");
        }

        private static void DrainJobMessages(
            IntPtr completionPort, ref bool resourceViolation, int maximumMessages)
        {
            for (int i = 0; i < maximumMessages; i++)
            {
                uint message;
                UIntPtr key;
                IntPtr overlapped;
                bool dequeued = GetQueuedCompletionStatus(
                    completionPort, out message, out key, out overlapped, 0);
                if (!dequeued)
                {
                    int error = Marshal.GetLastWin32Error();
                    if (error == unchecked((int)WAIT_TIMEOUT))
                        return;
                    throw new Win32Exception(error);
                }
                if (message == JOB_OBJECT_MSG_ACTIVE_PROCESS_LIMIT ||
                    message == JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT ||
                    message == JOB_OBJECT_MSG_JOB_MEMORY_LIMIT)
                    resourceViolation = true;
            }
        }

        private static ulong QueryPeakJobMemory(IntPtr job)
        {
            return QueryJobInformation<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>(
                job, JobObjectExtendedLimitInformation).PeakJobMemoryUsed.ToUInt64();
        }

        private static void SetJobInformation<T>(IntPtr job, int informationClass, T value)
            where T : struct
        {
            int size = Marshal.SizeOf(typeof(T));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(value, buffer, false);
                if (!SetInformationJobObject(job, informationClass, buffer, (uint)size))
                    throw NativeFailure("SetInformationJobObject");
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static T QueryJobInformation<T>(IntPtr job, int informationClass)
            where T : struct
        {
            int size = Marshal.SizeOf(typeof(T));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                uint returned;
                if (!QueryInformationJobObject(job, informationClass, buffer, (uint)size, out returned))
                    throw NativeFailure("QueryInformationJobObject");
                return (T)Marshal.PtrToStructure(buffer, typeof(T));
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static Exception NativeFailure(string operation)
        {
            return new Win32Exception(Marshal.GetLastWin32Error(), operation);
        }

        private static void CloseHandleChecked(ref IntPtr handle)
        {
            if (handle != IntPtr.Zero && handle != InvalidHandleValue)
            {
                CloseHandle(handle);
                handle = IntPtr.Zero;
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private sealed class MEMORYSTATUSEX
        {
            public uint dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
            public uint dwMemoryLoad;
            public ulong ullTotalPhys;
            public ulong ullAvailPhys;
            public ulong ullTotalPageFile;
            public ulong ullAvailPageFile;
            public ulong ullTotalVirtual;
            public ulong ullAvailVirtual;
            public ulong ullAvailExtendedVirtual;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SECURITY_ATTRIBUTES
        {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public uint dwX;
            public uint dwY;
            public uint dwXSize;
            public uint dwYSize;
            public uint dwXCountChars;
            public uint dwYCountChars;
            public uint dwFillAttribute;
            public uint dwFlags;
            public ushort wShowWindow;
            public ushort cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct STARTUPINFOEX
        {
            public STARTUPINFO StartupInfo;
            public IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_ASSOCIATE_COMPLETION_PORT
        {
            public IntPtr CompletionKey;
            public IntPtr CompletionPort;
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(
            IntPtr job, int informationClass, IntPtr information, uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryInformationJobObject(
            IntPtr job, int informationClass, IntPtr information, uint informationLength, out uint returnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcess(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFOEX startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool InitializeProcThreadAttributeList(
            IntPtr attributeList,
            int attributeCount,
            uint flags,
            ref UIntPtr size);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UpdateProcThreadAttribute(
            IntPtr attributeList,
            uint flags,
            IntPtr attribute,
            IntPtr value,
            UIntPtr size,
            IntPtr previousValue,
            IntPtr returnSize);

        [DllImport("kernel32.dll")]
        private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreatePipe(
            out IntPtr readPipe, out IntPtr writePipe, ref SECURITY_ATTRIBUTES attributes, uint size);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CancelIoEx(SafeFileHandle handle, IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateIoCompletionPort(
            IntPtr fileHandle, IntPtr existingCompletionPort, UIntPtr completionKey, uint concurrentThreads);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetQueuedCompletionStatus(
            IntPtr completionPort,
            out uint bytesTransferred,
            out UIntPtr completionKey,
            out IntPtr overlapped,
            uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GlobalMemoryStatusEx([In, Out] MEMORYSTATUSEX buffer);
    }
}
