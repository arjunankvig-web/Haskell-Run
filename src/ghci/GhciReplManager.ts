import * as vscode from "vscode";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";

// Core type for command queue management
interface GhciCommand {
  command: string;
  resolve: (output: string) => void;
  reject: (error: string) => void;
}

/**
 * GhciReplManager - Central control for GHCi REPL process
 * 
 * Features:
 * - Prompt-based output detection (no hard-coded delays)
 * - Serialized command queue to prevent race conditions
 * - Automatic error detection and reporting
 * - State updates only on successful operations
 * - Defensive timeout handling (failsafe only)
 */
export class GhciReplManager {
  private ghci: ChildProcessWithoutNullStreams | null = null;
  private commandQueue: GhciCommand[] = [];
  private isRunning = false;
  private outputBuffer = "";

  // Regex patterns for GHCi output detection
  private PROMPT_REGEX = />\s*$/;
  private ERROR_REGEX = /(error:|Failed,|Could not find module|parse error|Variable not in scope)/i;

  constructor(private outputChannel: vscode.OutputChannel) {
    this.initialize();
  }

  /**
   * Initialize GHCi process with proper event handlers
   */
  private initialize() {
    try {
      this.ghci = spawn("ghci", [], { stdio: "pipe" });

      if (!this.ghci) {
        throw new Error("Failed to spawn GHCi process");
      }

      this.ghci.stdout.on("data", (data) => this.onData(data.toString()));
      this.ghci.stderr.on("data", (data) => this.onData(data.toString()));

      this.ghci.on("exit", () => {
        this.outputChannel.appendLine("⚠️ GHCi process exited unexpectedly");
        vscode.window.showErrorMessage("GHCi process exited unexpectedly.");
        this.resetState();
      });

      this.ghci.on("error", (error) => {
        this.outputChannel.appendLine(`⚠️ GHCi error: ${error.message}`);
        vscode.window.showErrorMessage(`GHCi error: ${error.message}`);
        this.resetState();
      });

      this.outputChannel.appendLine("✓ GHCi REPL initialized");
    } catch (error) {
      this.outputChannel.appendLine(`✗ Failed to initialize GHCi: ${error}`);
      vscode.window.showErrorMessage(`Failed to initialize GHCi: ${error}`);
    }
  }

  /**
   * Handle incoming data from GHCi stdout/stderr
   * Detects prompt and resolves pending commands
   */
  private onData(data: string) {
    this.outputBuffer += data;
    this.outputChannel.appendLine(`[GHCi] ${data.trim()}`);

    // Check if we've received the GHCi prompt
    if (this.PROMPT_REGEX.test(this.outputBuffer)) {
      const fullOutput = this.outputBuffer;
      this.outputBuffer = "";

      const current = this.commandQueue.shift();
      this.isRunning = false;

      if (!current) {
        // Prompt received but no command pending - just keep waiting
        this.runNext();
        return;
      }

      // Parse output for errors
      if (this.ERROR_REGEX.test(fullOutput)) {
        current.reject(fullOutput);
      } else {
        current.resolve(fullOutput);
      }

      // Process next command in queue
      this.runNext();
    }
  }

  /**
   * Execute the next command in the queue
   */
  private runNext() {
    if (this.isRunning) {
      return;
    }
    if (this.commandQueue.length === 0) {
      return;
    }
    if (!this.ghci) {
      this.outputChannel.appendLine("✗ GHCi process not available");
      return;
    }

    const next = this.commandQueue[0];
    this.isRunning = true;

    try {
      this.ghci.stdin.write(next.command + "\n");
    } catch (error) {
      this.outputChannel.appendLine(`✗ Failed to write command: ${error}`);
      next.reject(`Failed to send command: ${error}`);
      this.commandQueue.shift();
      this.isRunning = false;
      this.runNext();
    }
  }

  /**
   * Execute a command and return promise of output
   * 
   * @param command - GHCi command to execute
   * @returns Promise resolving with command output or rejecting with error
   */
  runCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.commandQueue.push({ command, resolve, reject });
      this.runNext();

      // Defensive timeout (failsafe only) - 10 seconds
      const timeoutHandle = setTimeout(() => {
        const index = this.commandQueue.findIndex(
          (cmd) => cmd.command === command
        );
        if (index !== -1) {
          this.outputChannel.appendLine(`✗ Command timeout: ${command}`);
          this.commandQueue.splice(index, 1);
          reject("GHCi did not respond in time.");
          this.resetState();
        }
      }, 10000);

      // Clear timeout if command completes (via resolve or reject)
      const originalResolve = resolve;
      const originalReject = reject;

      const wrappedResolve = (output: string) => {
        clearTimeout(timeoutHandle);
        originalResolve(output);
      };

      const wrappedReject = (error: string) => {
        clearTimeout(timeoutHandle);
        originalReject(error);
      };

      // Replace the resolve/reject in the command queue item
      const queuedCommand = this.commandQueue[this.commandQueue.length - 1];
      queuedCommand.resolve = wrappedResolve;
      queuedCommand.reject = wrappedReject;
    });
  }

  /**
   * Load a Haskell module file
   * State is updated only on successful load
   * 
   * @param filePath - Full path to the .hs file
   * @param moduleName - Display name for the module
   * @param loadedModules - Set to track loaded modules
   */
  async loadModule(
    filePath: string,
    moduleName: string,
    loadedModules: Set<string>
  ): Promise<string> {
    try {
      this.outputChannel.appendLine(`📦 Loading module: ${moduleName} from ${filePath}`);
      const output = await this.runCommand(`:load ${filePath}`);
      loadedModules.add(moduleName);
      this.outputChannel.appendLine(`✓ Loaded ${moduleName} successfully`);
      vscode.window.showInformationMessage(`Loaded ${moduleName} successfully`);
      return output;
    } catch (err) {
      const errorMsg = `Failed to load ${moduleName}:\n${err}`;
      this.outputChannel.appendLine(`✗ ${errorMsg}`);
      vscode.window.showErrorMessage(errorMsg);
      throw err;
    }
  }

  /**
   * Reload the current module(s)
   * State is updated only on successful reload
   * 
   * @param moduleName - Display name of the module being reloaded
   * @param loadedModules - Set to track loaded modules
   */
  async reloadModule(
    moduleName: string,
    loadedModules: Set<string>
  ): Promise<string> {
    try {
      this.outputChannel.appendLine(`🔄 Reloading ${moduleName}`);
      const output = await this.runCommand(`:reload`);
      this.outputChannel.appendLine(`✓ Reloaded ${moduleName}`);
      vscode.window.showInformationMessage(`Reloaded ${moduleName}`);
      return output;
    } catch (err) {
      const errorMsg = `Reload failed:\n${err}`;
      this.outputChannel.appendLine(`✗ ${errorMsg}`);
      vscode.window.showErrorMessage(errorMsg);
      throw err;
    }
  }

  /**
   * Evaluate an expression in GHCi
   * 
   * @param expression - Haskell expression to evaluate
   */
  async evaluate(expression: string): Promise<string> {
    try {
      this.outputChannel.appendLine(`▶️  Evaluating: ${expression}`);
      const output = await this.runCommand(expression);
      this.outputChannel.appendLine(`✓ Evaluation complete`);
      return output;
    } catch (err) {
      const errorMsg = `Evaluation failed: ${err}`;
      this.outputChannel.appendLine(`✗ ${errorMsg}`);
      throw err;
    }
  }

  /**
   * Reset internal state on failure or crash
   * Clears queue and resets flags
   */
  private resetState() {
    this.commandQueue = [];
    this.isRunning = false;
    this.outputBuffer = "";
    this.outputChannel.appendLine("⚠️ REPL state reset");
  }

  /**
   * Terminate the GHCi process and clean up resources
   */
  dispose() {
    if (this.ghci) {
      try {
        this.ghci.kill();
      } catch (error) {
        this.outputChannel.appendLine(`⚠️ Error terminating GHCi: ${error}`);
      }
      this.ghci = null;
    }
    this.resetState();
    this.outputChannel.appendLine("✓ GHCi REPL disposed");
  }

  /**
   * Check if REPL is currently running
   */
  isAlive(): boolean {
    return this.ghci !== null && !this.ghci.killed;
  }

  /**
   * Get the current output buffer (for debugging)
   */
  getOutputBuffer(): string {
    return this.outputBuffer;
  }
}
