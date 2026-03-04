#!/usr/bin/env node
/**
 * Development mode script - runs extension logic in standalone mode
 * This allows testing and debugging outside of VS Code
 * 
 * Usage: npm run dev:standalone
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../packages/vscode-extension/src/logger';

// Configure logger for development
const logger = new Logger({
  logDir: path.join(process.cwd(), '.logs'),
  logFile: path.join(process.cwd(), '.logs', 'dev-mode.log'),
  consoleOutput: true,
  fileOutput: true,
  minLevel: 'DEBUG' as any
});

logger.info('Development mode started', {
  cwd: process.cwd(),
  nodeVersion: process.version,
  platform: process.platform
});

// Example: Test markdown parsing
function testMarkdownParsing() {
  const exampleFile = path.join(process.cwd(), 'example-tasks', 'TASKS.md');
  
  if (!fs.existsSync(exampleFile)) {
    logger.warn('Example file not found', { exampleFile });
    return;
  }

  logger.info('Testing markdown parsing', { file: exampleFile });
  
  try {
    const content = fs.readFileSync(exampleFile, 'utf8');
    logger.debug('File content loaded', { size: content.length });

    // Import parser dynamically to avoid VS Code dependencies
    import('../packages/vscode-extension/src/markdownParser').then(({ MarkdownKanbanParser }) => {
      const board = MarkdownKanbanParser.parseMarkdownWithDetails(content, exampleFile);
      
      logger.info('Parsing successful', {
        title: board.title,
        columns: board.columns.length,
        tasks: board.columns.reduce((sum, col) => sum + col.tasks.length, 0)
      });

      // Log each task
      board.columns.forEach((column, colIdx) => {
        logger.debug(`Column ${colIdx + 1}`, {
          title: column.title,
          archived: column.archived,
          taskCount: column.tasks.length
        });

        column.tasks.forEach((task, taskIdx) => {
          logger.debug(`Task ${taskIdx + 1} in column "${column.title}"`, {
            id: task.id,
            title: task.title,
            priority: task.priority,
            workload: task.workload,
            startDate: task.startDate,
            dueDate: task.dueDate,
            tags: task.tags,
            hasDescription: !!task.description,
            stepsCount: task.steps?.length || 0
          });
        });
      });
    }).catch((error) => {
      logger.error('Failed to import parser', { error: error.message });
    });

  } catch (error) {
    logger.error('Failed to read file', {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

// Main execution
console.log('\n=== MapCtx - Development Mode ===\n');
console.log('This mode allows testing extension logic outside VS Code');
console.log('All logs are written to both console and .logs/dev-mode.log\n');
console.log('To watch logs in real-time, run in another terminal:');
console.log('  tail -f .logs/dev-mode.log\n');
console.log('----------------------------------------\n');

testMarkdownParsing();

// Keep process alive for a bit to allow async operations
setTimeout(() => {
  logger.info('Development mode completed');
  console.log('\n=== Development mode completed ===');
  console.log('Check .logs/dev-mode.log for detailed logs');
}, 2000);

