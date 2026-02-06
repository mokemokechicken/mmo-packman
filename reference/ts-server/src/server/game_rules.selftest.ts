import assert from 'node:assert/strict';
import type { RandomSource } from './game_rules.js';
import {
  isMoveDirection,
  oppositeOf,
  pickFruitType,
  pickGhostType,
} from './game_rules.js';

function fixedRng(value: number): RandomSource {
  return {
    next: () => value,
  };
}

function testPickGhostTypeBoundaries(): void {
  assert.equal(pickGhostType(0.1, fixedRng(0.749)), 'random');
  assert.equal(pickGhostType(0.1, fixedRng(0.75)), 'chaser');
  assert.equal(pickGhostType(0.3, fixedRng(0.74)), 'patrol');

  assert.equal(pickGhostType(0.59, fixedRng(0.299)), 'random');
  assert.equal(pickGhostType(0.59, fixedRng(0.3)), 'chaser');
  assert.equal(pickGhostType(0.59, fixedRng(0.549)), 'chaser');
  assert.equal(pickGhostType(0.59, fixedRng(0.55)), 'patrol');
  assert.equal(pickGhostType(0.59, fixedRng(0.799)), 'patrol');
  assert.equal(pickGhostType(0.59, fixedRng(0.8)), 'pincer');
  assert.equal(pickGhostType(0.6, fixedRng(0.79)), 'pincer');

  assert.equal(pickGhostType(0.89, fixedRng(0.199)), 'random');
  assert.equal(pickGhostType(0.89, fixedRng(0.2)), 'chaser');
  assert.equal(pickGhostType(0.89, fixedRng(0.399)), 'chaser');
  assert.equal(pickGhostType(0.89, fixedRng(0.4)), 'patrol');
  assert.equal(pickGhostType(0.89, fixedRng(0.599)), 'patrol');
  assert.equal(pickGhostType(0.89, fixedRng(0.6)), 'pincer');
  assert.equal(pickGhostType(0.89, fixedRng(0.799)), 'pincer');
  assert.equal(pickGhostType(0.89, fixedRng(0.8)), 'invader');

  assert.equal(pickGhostType(0.9, fixedRng(0.099)), 'random');
  assert.equal(pickGhostType(0.9, fixedRng(0.1)), 'chaser');
  assert.equal(pickGhostType(0.9, fixedRng(0.249)), 'chaser');
  assert.equal(pickGhostType(0.9, fixedRng(0.25)), 'pincer');
  assert.equal(pickGhostType(0.9, fixedRng(0.499)), 'pincer');
  assert.equal(pickGhostType(0.9, fixedRng(0.5)), 'invader');
  assert.equal(pickGhostType(0.9, fixedRng(0.799)), 'invader');
  assert.equal(pickGhostType(0.9, fixedRng(0.8)), 'boss');
}

function testPickFruitTypeBoundaries(): void {
  assert.equal(pickFruitType(fixedRng(0.199)), 'cherry');
  assert.equal(pickFruitType(fixedRng(0.2)), 'grape');
  assert.equal(pickFruitType(fixedRng(0.349)), 'grape');
  assert.equal(pickFruitType(fixedRng(0.35)), 'orange');
  assert.equal(pickFruitType(fixedRng(0.499)), 'orange');
  assert.equal(pickFruitType(fixedRng(0.5)), 'strawberry');
  assert.equal(pickFruitType(fixedRng(0.649)), 'strawberry');
  assert.equal(pickFruitType(fixedRng(0.65)), 'key');
  assert.equal(pickFruitType(fixedRng(0.819)), 'key');
  assert.equal(pickFruitType(fixedRng(0.82)), 'apple');
}

function testDirectionHelpers(): void {
  assert.equal(oppositeOf('up'), 'down');
  assert.equal(oppositeOf('down'), 'up');
  assert.equal(oppositeOf('left'), 'right');
  assert.equal(oppositeOf('right'), 'left');
  assert.equal(oppositeOf('none'), null);

  assert.equal(isMoveDirection('up'), true);
  assert.equal(isMoveDirection('down'), true);
  assert.equal(isMoveDirection('left'), true);
  assert.equal(isMoveDirection('right'), true);
  assert.equal(isMoveDirection('none'), false);
}

function run(): void {
  testPickGhostTypeBoundaries();
  testPickFruitTypeBoundaries();
  testDirectionHelpers();
  console.log('game rules selftest: OK');
}

run();
