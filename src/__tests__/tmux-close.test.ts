import { test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import {
  closeTmuxPane,
  setSpawnAsyncFn,
  resetSpawnAsyncFn,
  resetTmuxPathCache,
} from '../utils/tmux';
import * as processUtils from '../utils/process';

// Mock spawnAsync
interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type MockSpawnFn = (
  command: string[],
  options?: { ignoreOutput?: boolean },
) => Promise<SpawnResult>;

function createMockSpawnFn() {
  const calls: Array<{ command: string[]; options?: { ignoreOutput?: boolean } }> = [];
  const results: SpawnResult[] = [];

  const fn: MockSpawnFn = async (command, options) => {
    calls.push({ command, options });
    const result = results.shift();
    if (!result) {
      // Default success
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return result;
  };

  return { fn, calls, results };
}

let mockSpawnData: ReturnType<typeof createMockSpawnFn>;

beforeEach(() => {
  resetTmuxPathCache();
  resetSpawnAsyncFn();
  mockSpawnData = createMockSpawnFn();
  setSpawnAsyncFn(mockSpawnData.fn);
  
  // Mock process utils
  spyOn(processUtils, 'getProcessChildren').mockReturnValue([]);
  spyOn(processUtils, 'safeKill').mockReturnValue(true);
  spyOn(processUtils, 'waitForProcessExit').mockResolvedValue(true);
  spyOn(processUtils, 'getProcessCommand').mockReturnValue('opencode attach');
});

afterEach(() => {
  resetSpawnAsyncFn();
  mock.restore();
});

test('closeTmuxPane closes exact pane without killing child processes', async () => {
  // Setup mocks
  mockSpawnData.results.push(
    { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' }, // find tmux
    { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' }, // verify tmux
    { exitCode: 0, stdout: '%1\t12345\topencode\n%2\t22222\tbash\n', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' }, // kill-pane
    { exitCode: 0, stdout: '', stderr: '' }, // layout
  );

  const safeKillSpy = spyOn(processUtils, 'safeKill');

  const result = await closeTmuxPane('%1');

  expect(result).toBe(true);

  expect(processUtils.getProcessChildren).not.toHaveBeenCalled();
  expect(safeKillSpy).not.toHaveBeenCalled();

  const listPanesCall = mockSpawnData.calls.find(c => c.command.includes('list-panes'));
  expect(listPanesCall?.command).toEqual(['/usr/bin/tmux', 'list-panes', '-a', '-F', '#{pane_id}\t#{pane_pid}\t#{pane_current_command}']);

  // Verify tmux flow
  const killPaneCall = mockSpawnData.calls.find(c => c.command.includes('kill-pane'));
  expect(killPaneCall?.command).toEqual(['/usr/bin/tmux', 'kill-pane', '-t', '%1']);
});

test('closeTmuxPane refuses to close when stored pane id is missing', async () => {
  mockSpawnData.results.push(
    { exitCode: 0, stdout: '/usr/bin/tmux\n', stderr: '' },
    { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' },
    { exitCode: 0, stdout: '%2\t22222\tbash\n', stderr: '' },
  );

  const safeKillSpy = spyOn(processUtils, 'safeKill');

  const result = await closeTmuxPane('%1');

  expect(result).toBe(false);
  expect(safeKillSpy).not.toHaveBeenCalled();
  expect(mockSpawnData.calls.some(c => c.command.includes('kill-pane'))).toBe(false);
});
