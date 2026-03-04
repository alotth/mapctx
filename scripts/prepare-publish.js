#!/usr/bin/env node
/**
 * Script para preparar a extensão para publicação
 * Remove/comenta logs de debug e valida configurações
 */

const fs = require('fs');
const path = require('path');

const DEBUG_PATTERNS = [
  /\.cursor\/debug\.log/g,
  /\/Users\/alt\/repos\/markdown-kanban-roadmap\/\.cursor\/debug\.log/g,
  /MARKDOWN_KANBAN_UI_DEBUG/g,
  /#region agent log/g,
  /#endregion/g
];

const FILES_TO_CHECK = [
  'packages/vscode-extension/src/kanbanWebviewPanel.ts',
  'packages/vscode-extension/src/markdownParser.ts'
];

function checkForDebugCode() {
  console.log('🔍 Verificando código de debug...\n');
  
  let foundIssues = false;
  
  FILES_TO_CHECK.forEach(file => {
    const filePath = path.join(process.cwd(), file);
    if (!fs.existsSync(filePath)) {
      console.log(`⚠️  Arquivo não encontrado: ${file}`);
      return;
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    
    lines.forEach((line, index) => {
      DEBUG_PATTERNS.forEach(pattern => {
        if (pattern.test(line)) {
          console.log(`⚠️  ${file}:${index + 1} - Possível código de debug encontrado`);
          console.log(`   ${line.trim().substring(0, 80)}...\n`);
          foundIssues = true;
        }
      });
    });
  });
  
  if (!foundIssues) {
    console.log('✅ Nenhum código de debug hardcoded encontrado!\n');
  } else {
    console.log('⚠️  Código de debug encontrado. Considere remover antes de publicar.\n');
  }
  
  return foundIssues;
}

function checkPackageJson() {
  console.log('📦 Verificando package.json...\n');
  
  const packagePath = path.join(process.cwd(), 'packages/vscode-extension/package.json');
  if (!fs.existsSync(packagePath)) {
    console.log('❌ package.json não encontrado!\n');
    return false;
  }
  
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const issues = [];
  
  // Verificar publisher
  if (!pkg.publisher || pkg.publisher === 'holooooo') {
    issues.push('⚠️  Publisher não configurado ou ainda usando o original');
  }
  
  // Verificar repository
  if (!pkg.repository || !pkg.repository.url || pkg.repository.url.includes('holooooo')) {
    issues.push('⚠️  Repository URL não configurado ou ainda usando o original');
  }
  
  // Verificar version
  if (!pkg.version || pkg.version === '1.3.1') {
    issues.push('⚠️  Versão pode precisar ser atualizada para 1.0.0 (primeira publicação)');
  }
  
  if (issues.length === 0) {
    console.log('✅ package.json parece estar configurado corretamente!\n');
    return true;
  } else {
    console.log('⚠️  Problemas encontrados no package.json:\n');
    issues.forEach(issue => console.log(`   ${issue}\n`));
    return false;
  }
}

function checkVscodeIgnore() {
  console.log('📋 Verificando .vscodeignore...\n');
  
  const ignorePath = path.join(process.cwd(), '.vscodeignore');
  if (!fs.existsSync(ignorePath)) {
    console.log('⚠️  .vscodeignore não encontrado!\n');
    return false;
  }
  
  const content = fs.readFileSync(ignorePath, 'utf8');
  const requiredExcludes = [
    'src/**/*.ts',
    'scripts',
    '.logs',
    '.cursor'
  ];
  
  const missing = requiredExcludes.filter(pattern => !content.includes(pattern));
  
  if (missing.length === 0) {
    console.log('✅ .vscodeignore parece estar configurado corretamente!\n');
    return true;
  } else {
    console.log('⚠️  Padrões recomendados não encontrados em .vscodeignore:\n');
    missing.forEach(pattern => console.log(`   - ${pattern}\n`));
    return false;
  }
}

function main() {
  console.log('🚀 Preparando extensão para publicação...\n');
  console.log('='.repeat(50) + '\n');
  
  const checks = [
    checkPackageJson(),
    checkVscodeIgnore(),
    !checkForDebugCode() // Invertido porque foundIssues = true é problema
  ];
  
  console.log('='.repeat(50) + '\n');
  
  const allPassed = checks.every(check => check === true);
  
  if (allPassed) {
    console.log('✅ Todas as verificações passaram!\n');
    console.log('📝 Próximos passos:');
    console.log('   1. Atualize package.json com suas informações');
    console.log('   2. Execute: npm run package');
    console.log('   3. Execute: vsce package');
    console.log('   4. Publique no marketplace\n');
    process.exit(0);
  } else {
    console.log('⚠️  Algumas verificações falharam. Revise antes de publicar.\n');
    console.log('📖 Consulte PUBLISH.md para mais informações.\n');
    process.exit(1);
  }
}

main();












