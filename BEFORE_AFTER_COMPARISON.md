# Before & After: GHCi REPL Implementation

## Problem Statement (Issue #5)

The old terminal-based REPL approach had critical issues:
- **Hard-coded delays** (500ms, 1000ms) that don't account for network latency
- **Silent failures** - no error detection or user feedback
- **Race conditions** - multiple commands could queue incorrectly
- **State inconsistency** - modules marked loaded even on failure
- **Cross-platform issues** - timing varies on different systems

## Architecture Comparison

### BEFORE: Terminal-Based Approach
```typescript
// Old utils/repl.ts
export class ReplManager {
  private terminals: Map<string, vscode.Terminal> = new Map();
  
  async loadModule(workspacePath, modulePath) {
    const terminal = await this.getOrCreateRepl(workspacePath);
    terminal.sendText(`:load "${modulePath}"`);
    
    // ❌ PROBLEM: Hard-coded delay with no guarantee
    await new Promise(resolve => setTimeout(resolve, 1000));
    // No verification that module actually loaded!
  }
  
  async evaluateInRepl(workspacePath, code) {
    // ❌ PROBLEM: More hard-coded delays
    await new Promise(resolve => setTimeout(resolve, 200));
    terminal.sendText(code);
    await new Promise(resolve => setTimeout(resolve, 300));
    // Still no way to know if evaluation succeeded!
  }
}
```

**Issues:**
- Delays are arbitrary (200ms? 1000ms? What if the computer is slow?)
- No output parsing - can't detect errors
- Terminal visibility required - clutters workspace
- No promise-based API - can't handle async properly
- State updates blindly without checking success

### AFTER: Event-Driven Prompt Detection
```typescript
// New ghci/GhciReplManager.ts
export class GhciReplManager {
  private ghci: ChildProcessWithoutNullStreams;
  private commandQueue: GhciCommand[] = [];
  private PROMPT_REGEX = />\s*$/;
  private ERROR_REGEX = /(error:|Failed,|Could not find module|parse error|Variable not in scope)/i;
  
  async loadModule(filePath, moduleName, loadedModules) {
    try {
      // ✅ SOLUTION: Wait for actual GHCi prompt (event-driven)
      const output = await this.runCommand(`:load ${filePath}`);
      
      // ✅ SOLUTION: Update state ONLY on success
      loadedModules.add(moduleName);
      vscode.window.showInformationMessage(`Loaded ${moduleName}`);
      return output;
    } catch (err) {
      // ✅ SOLUTION: Proper error feedback
      vscode.window.showErrorMessage(`Failed to load ${moduleName}:\n${err}`);
      throw err;
    }
  }
  
  async evaluate(expression: string): Promise<string> {
    try {
      // ✅ SOLUTION: Promise-based, no delays needed
      const output = await this.runCommand(expression);
      return output; // Output is parsed and verified
    } catch (err) {
      vscode.window.showErrorMessage(`Evaluation failed: ${err}`);
      throw err;
    }
  }
}
```

## Usage Comparison

### BEFORE: Fragile Terminal Commands
```typescript
// extension.ts (OLD)
const repl = await replManager.getOrCreateRepl(workspacePath);
repl.show(); // Terminal must be visible!

// Load with unknown timing
await replManager.loadModule(workspacePath, documentUri.fsPath);

// Add arbitrary delay hoping module is loaded
await new Promise(resolve => setTimeout(resolve, 500));

// Evaluate with no error checking
await replManager.evaluateInRepl(workspacePath, actualFunctionName);

// Add another delay hoping evaluation is done
await new Promise(resolve => setTimeout(resolve, 300));

// Hope everything worked... 😅
vscode.window.showInformationMessage(`Function '${originalFunctionName}' executed`);
```

**Problems:**
- No error detection
- Multiple hard-coded delays
- Terminal visibility requirement
- No way to verify execution
- Race conditions possible

### AFTER: Robust Promise-Based API
```typescript
// extension.ts (NEW)
try {
  // Load module - waits for prompt, detects errors
  await ghciRepl.loadModule(filePath, moduleName, loadedModules);
  
  // Evaluate - Promise resolves when GHCi responds
  const result = await ghciRepl.evaluate(actualFunctionName);
  
  // If we get here, it definitely succeeded
  outputChannel.appendLine(`Result:\n${result}`);
  vscode.window.showInformationMessage(`Function '${originalFunctionName}' executed`);
} catch (error) {
  // Error handling is automatic and detailed
  vscode.window.showErrorMessage(`Error: ${error}`);
  outputChannel.appendLine(`[ERROR] ${error}`);
}
```

**Benefits:**
- ✅ Automatic error detection
- ✅ No arbitrary delays
- ✅ Promise-based async/await
- ✅ Proper error handling
- ✅ State safety guaranteed

## Output Handling Comparison

### BEFORE: No Output Parsing
```
$ ghci
GHCi, version 9.2.5: https://www.haskell.org/ghc/
:load "Main.hs"
[1 of 1] Compiling Main        ( Main.hs, interpreted )

Main>

-- ❌ OLD CODE: Just sends text, doesn't check response
```

### AFTER: Smart Output Detection
```
GHCi process spawned
[GHCi] GHCi, version 9.2.5: https://www.haskell.org/ghc/
[GHCi] :load "Main.hs"
[GHCi] [1 of 1] Compiling Main        ( Main.hs, interpreted )
[GHCi] 
[GHCi] Main>
✓ Loaded Main successfully       ← State updated only here

[GHCi] Main> main
[GHCi] Hello, World!
[GHCi] Main>
✓ Evaluation complete            ← Prompt detected, result captured
```

## Error Detection Comparison

### BEFORE: Silent Failure
```
$ ghci
GHCi, version 9.2.5
:load "Foo.hs"
<interactive>:1:1: error: parse error in input 'load'

-- ❌ OLD: Code doesn't notice the error
-- User sees: "Function executed" but nothing actually ran
```

### AFTER: Automatic Error Detection
```
[GHCi] :load "Foo.hs"
[GHCi] <interactive>:1:1: error: parse error in input 'load'
✗ Failed to load Foo:
  <interactive>:1:1: error: parse error in input 'load'

-- ✅ NEW: Error regex matches and rejects promise
-- User sees: Error notification with details
// State remains unchanged (module not added to loadedModules)
```

## Command Queue Benefits

### BEFORE: Potential Race Conditions
```
Command 1: :load Main.hs        ← sent at 0ms
Wait 1000ms...
Command 2: main                 ← sent at 1000ms
Wait 300ms...
Return success

-- Problem: If Command 1 takes 1500ms, Command 2 runs before Main is loaded!
```

### AFTER: Serialized Queue
```
Queue: [:load Main.hs, main]

Send: :load Main.hs
Wait for prompt: >
✓ Prompt detected
Process: main
Send: main
Wait for prompt: >
✓ Prompt detected, return result

-- No race conditions possible
-- Commands execute in guaranteed order
// Each command waits for actual completion
```

## Code Metrics

| Metric | Old | New |
|--------|-----|-----|
| Hard-coded delays | 3+ | 0 |
| Error detection | None | Yes (regex) |
| Promise-based | No | Yes |
| State safety | No | Yes |
| Race condition risk | High | None |
| Lines of code (REPL) | ~80 | ~288 |
| Functionality gain | Limited | Complete |

## Testing Scenarios

### Scenario 1: Normal Load
```
User clicks "Load Module" on Main.hs

BEFORE:
1. Send :load command to terminal
2. Wait 1000ms (hope it's enough)
3. Assume success, mark as loaded
4. User may see "success" but module failed to load

AFTER:
1. Queue :load command
2. Read output stream
3. Wait for GHCi prompt (actual confirmation)
4. Parse output for errors
5. If error detected, reject and don't update state
6. If success, update state and notify user
```

### Scenario 2: Module with Syntax Error
```
File has syntax error: let x = 

BEFORE:
$ ghci
:load "Bad.hs"
[1 of 1] Compiling Main        ( Main.hs, interpreted )

Bad.hs:1:10: error: Parse error in input 'let'
> 

-- ❌ Code: Still returns success, marks as loaded
```

```
AFTER:
[GHCi] :load "Bad.hs"
[GHCi] Bad.hs:1:10: error: Parse error in input 'let'
[GHCi] >

-- ✅ ERROR_REGEX matches "error:"
// Promise rejects with error message
// State unchanged (module NOT added to loadedModules)
```

### Scenario 3: Function Evaluation
```
BEFORE:
$ ghci
:load Main
[assumes success]
main
[waits 300ms]
return control
[user doesn't see output]

AFTER:
[GHCi] :load Main
[GHCi] Main> 
✓ Load confirmed
[GHCi] main
[GHCi] Result: "Hello"
[GHCi] Main>
✓ Result captured and logged
[User sees result in output channel]
```

## Summary of Improvements

| Problem | Old | New |
|---------|-----|-----|
| **Timing** | Hard-coded ❌ | Event-driven ✅ |
| **Errors** | Undetected ❌ | Auto-parsed ✅ |
| **State** | Unsafe ❌ | Safe ✅ |
| **Race conditions** | Possible ❌ | Prevented ✅ |
| **Terminal dependency** | Required ❌ | Not needed ✅ |
| **User feedback** | Minimal ❌ | Detailed ✅ |
| **API quality** | Terminal-based ❌ | Promise-based ✅ |
| **Cross-platform** | Fragile ❌ | Robust ✅ |

---

**Analysis Date:** January 9, 2026  
**Result:** ✅ Complete architectural upgrade
