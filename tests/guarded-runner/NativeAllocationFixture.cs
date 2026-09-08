using System;
using System.Runtime.InteropServices;
using System.Threading;

internal static class NativeAllocationFixture
{
    private const uint MemCommit = 0x1000;
    private const uint MemReserve = 0x2000;
    private const uint MemRelease = 0x8000;
    private const uint PageReadWrite = 0x04;
    private const int AllocationDeniedExitCode = 42;
    private const int AllocationUnexpectedlySucceededExitCode = 43;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr VirtualAlloc(
        IntPtr address,
        UIntPtr size,
        uint allocationType,
        uint protect);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool VirtualFree(IntPtr address, UIntPtr size, uint freeType);

    public static int Main()
    {
        UIntPtr bytes = new UIntPtr(128UL * 1024UL * 1024UL);
        IntPtr allocation = VirtualAlloc(
            IntPtr.Zero,
            bytes,
            MemReserve | MemCommit,
            PageReadWrite);

        if (allocation == IntPtr.Zero)
        {
            Console.WriteLine("ALLOCATION_DENIED");
            return AllocationDeniedExitCode;
        }

        try
        {
            Marshal.WriteByte(allocation, 0, 1);
            Thread.Sleep(TimeSpan.FromSeconds(2));
            Console.WriteLine("ALLOCATION_UNEXPECTEDLY_SUCCEEDED");
            return AllocationUnexpectedlySucceededExitCode;
        }
        finally
        {
            VirtualFree(allocation, UIntPtr.Zero, MemRelease);
        }
    }
}
