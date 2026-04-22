/**
 * AnnouncerVoices — Manages dynamic announcer callouts based on match state.
 */

import { gameState } from '@/core/GameState';
import { Audio } from './AudioManager';
import { TEAM_BLUE, TEAM_RED } from '@/config/constants';

let playedHalfway = false;
let played1Min = false;
let played10Sec = false;
let playedFinish = false;
let lastLeadState = 0; // 0 = tie, 1 = blue, -1 = red
let nextScoreCheckTime = 0;

export function resetAnnouncerState(): void {
  playedHalfway = false;
  played1Min = false;
  played10Sec = false;
  playedFinish = false;
  lastLeadState = 0;
  nextScoreCheckTime = gameState.worldElapsed + 5; // wait a bit before checking leads
}

export function updateAnnouncerVoices(dt: number): void {
  if (gameState.mode === 'br') return;
  if (gameState.roundOver || gameState.warmupTimer > 0) return;

  const now = gameState.worldElapsed;

  // 1. Time-based callouts
  const timeLimit = gameState.matchTime;
  const tr = gameState.matchTimeRemaining;
  if (timeLimit > 0) {
    if (!playedHalfway && tr <= timeLimit / 2 && tr > 60) {
      playedHalfway = true;
      Audio.play('announcer_halfway');
    }
    if (!played1Min && tr <= 60 && tr > 10) {
      played1Min = true;
      Audio.play('announcer_1min');
    }
    if (!played10Sec && tr <= 10 && tr > 0) {
      played10Sec = true;
      Audio.play('announcer_10sec');
    }
  }

  // 2. Score-based callouts (only check occasionally to avoid spam)
  if (now > nextScoreCheckTime) {
    nextScoreCheckTime = now + 2.0;

    const limit = gameState.scoreLimit;
    if (limit > 0) {
      let bScore = 0;
      let rScore = 0;

      if (gameState.mode === 'ffa') {
        bScore = gameState.pKills;
        for (const ag of gameState.agents) {
          if (ag !== gameState.player) {
            rScore = Math.max(rScore, ag.kills);
          }
        }
      } else {
        bScore = gameState.teamScores[TEAM_BLUE];
        rScore = gameState.teamScores[TEAM_RED];
      }

      // Check lead changes
      let currentLeadState = 0;
      if (bScore > rScore) currentLeadState = 1;
      else if (rScore > bScore) currentLeadState = -1;

      if (currentLeadState !== lastLeadState && currentLeadState !== 0) {
        if (currentLeadState === 1) { // We took the lead
          Audio.play('announcer_taken_lead');
        } else if (currentLeadState === -1) { // They took the lead
          if (lastLeadState === 1) {
            Audio.play('announcer_lost_lead');
          } else {
            Audio.play('announcer_enemy_ahead');
          }
        }
        lastLeadState = currentLeadState;
      } else if (currentLeadState === 1 && (bScore - rScore >= 5) && Math.random() < 0.2) {
        // Winning by a lot
        Audio.play('announcer_pressure');
        nextScoreCheckTime = now + 15.0; // Don't repeat often
      } else if (currentLeadState === -1 && (rScore - bScore >= 5) && Math.random() < 0.2) {
        // Losing by a lot
        Audio.play('announcer_fight_back');
        nextScoreCheckTime = now + 15.0;
      }

      // Check finish them / almost there
      const highestScore = Math.max(bScore, rScore);
      if (!playedFinish && highestScore >= limit - 3 && highestScore > 0) {
        playedFinish = true;
        if (bScore >= rScore) {
          Audio.play('announcer_finish_them');
        }
      }
    }
  }
}
