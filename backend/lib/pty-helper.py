#!/usr/bin/env python3
"""PTY helper — creates a real pseudo-terminal for shell sessions.
Communicates via stdin/stdout with the parent Node process.
"""
import pty, os, sys, select, signal, struct, fcntl, termios, re

RESIZE_RE = re.compile(rb'^\x1b\[8;(\d+);(\d+)t$')


def set_winsize(fd, rows, cols):
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)

def main():
    shell = os.environ.get('SHELL', '/bin/zsh')
    shell_name = os.path.basename(shell)
    pid, fd = pty.fork()
    
    if pid == 0:
        # Child — exec a login + interactive shell so we inherit the same
        # rc/profile behavior as a normal Terminal.app session.
        if shell_name in ('zsh', 'bash', 'sh', 'ksh'):
            os.execvp(shell, [shell, '-il'])
        elif shell_name == 'fish':
            os.execvp(shell, [shell, '-i', '-l'])
        else:
            os.execvp(shell, [shell])
    
    # Parent — relay between stdin/stdout and the PTY fd
    def handle_sigwinch(signum, frame):
        pass  # Resize handled via special messages
    
    signal.signal(signal.SIGWINCH, handle_sigwinch)
    
    # Set stdin to non-blocking
    import io
    stdin_fd = sys.stdin.buffer.fileno()
    
    try:
        while True:
            rlist, _, _ = select.select([fd, stdin_fd], [], [], 0.1)
            
            for r in rlist:
                if r == fd:
                    try:
                        data = os.read(fd, 4096)
                        if not data:
                            return
                        sys.stdout.buffer.write(data)
                        sys.stdout.buffer.flush()
                    except OSError:
                        return
                
                elif r == stdin_fd:
                    try:
                        data = os.read(stdin_fd, 4096)
                        if not data:
                            return
                        match = RESIZE_RE.match(data)
                        if match:
                            rows = int(match.group(1))
                            cols = int(match.group(2))
                            set_winsize(fd, rows, cols)
                            continue
                        os.write(fd, data)
                    except OSError:
                        return
            
            # Check if child is still alive
            result = os.waitpid(pid, os.WNOHANG)
            if result[0] != 0:
                # Drain remaining output
                try:
                    while True:
                        data = os.read(fd, 4096)
                        if not data:
                            break
                        sys.stdout.buffer.write(data)
                        sys.stdout.buffer.flush()
                except OSError:
                    pass
                return
    except KeyboardInterrupt:
        pass
    finally:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

if __name__ == '__main__':
    main()
