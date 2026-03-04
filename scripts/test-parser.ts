#!/usr/bin/env node
/**
 * Standalone script to test markdown parsing outside of VS Code
 * Usage: npm run test:parser <path-to-markdown-file>
 * Or: node scripts/test-parser.js <path-to-markdown-file>
 */

import * as fs from 'fs';
import * as path from 'path';
import { MarkdownKanbanParser, KanbanBoard } from '../packages/vscode-extension/src/markdownParser';
import { Logger } from '../packages/vscode-extension/src/logger';

// Create a logger that outputs to console and file
const logger = new Logger({
  logDir: path.join(process.cwd(), '.logs'),
  logFile: path.join(process.cwd(), '.logs', 'parser-test.log'),
  consoleOutput: true,
  fileOutput: true,
  minLevel: 'DEBUG' as any
});

function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('Usage: npm run test:parser <path-to-markdown-file>');
    console.error('Example: npm run test:parser example-tasks/TASKS.md');
    process.exit(1);
  }

  const filePath = path.resolve(args[0]);
  
  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  logger.info('Starting markdown parser test', { filePath });

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    logger.debug('File read successfully', { fileSize: content.length });

    logger.info('Parsing markdown...');
    const board = MarkdownKanbanParser.parseMarkdownWithDetails(content, filePath);
    
    logger.info('Parsing completed', {
      title: board.title,
      columnCount: board.columns.length,
      totalTasks: board.columns.reduce((sum, col) => sum + col.tasks.length, 0)
    });

    // Print board structure
    console.log('\n=== Board Structure ===');
    console.log(`Title: ${board.title}`);
    console.log(`Columns: ${board.columns.length}\n`);

    board.columns.forEach((column, colIndex) => {
      console.log(`Column ${colIndex + 1}: ${column.title}${column.archived ? ' [Archived]' : ''}`);
      console.log(`  Tasks: ${column.tasks.length}`);
      
      column.tasks.forEach((task, taskIndex) => {
        console.log(`  Task ${taskIndex + 1}: ${task.title} (${task.id})`);
        if (task.priority) console.log(`    Priority: ${task.priority}`);
        if (task.workload) console.log(`    Workload: ${task.workload}`);
        if (task.startDate) console.log(`    Start: ${task.startDate}`);
        if (task.dueDate) console.log(`    Due: ${task.dueDate}`);
        if (task.tags && task.tags.length > 0) console.log(`    Tags: ${task.tags.join(', ')}`);
        if (task.steps && task.steps.length > 0) {
          console.log(`    Steps: ${task.steps.length}`);
          task.steps.forEach((step, stepIndex) => {
            console.log(`      ${stepIndex + 1}. [${step.completed ? 'x' : ' '}] ${step.text}`);
          });
        }
        if (task.description) {
          const descPreview = task.description.substring(0, 100);
          console.log(`    Description: ${descPreview}${task.description.length > 100 ? '...' : ''}`);
        }
        console.log('');
      });
    });

    // Test markdown generation
    logger.info('Testing markdown generation...');
    const generatedMarkdown = MarkdownKanbanParser.generateMarkdown(board, 'title');
    logger.info('Markdown generation completed', { 
      generatedLength: generatedMarkdown.length,
      originalLength: content.length
    });

    // Save generated markdown for comparison
    const outputPath = path.join(process.cwd(), '.logs', 'generated-output.md');
    fs.writeFileSync(outputPath, generatedMarkdown, 'utf8');
    logger.info('Generated markdown saved', { outputPath });

    // Compare original and generated
    const linesMatch = content.split('\n').length === generatedMarkdown.split('\n').length;
    logger.info('Comparison result', { 
      linesMatch,
      originalLines: content.split('\n').length,
      generatedLines: generatedMarkdown.split('\n').length
    });

    console.log('\n=== Test Results ===');
    console.log('✓ Parsing successful');
    console.log(`✓ Generated markdown saved to: ${outputPath}`);
    console.log(`✓ Logs saved to: ${logger['logFile']}`);
    console.log('\nTo view logs in real-time, run:');
    console.log(`  tail -f ${logger['logFile']}`);

  } catch (error) {
    logger.error('Error during parsing', { 
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    console.error('\n=== Error ===');
    console.error(error);
    process.exit(1);
  }
}

main();

