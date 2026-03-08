/// Evaluator / Critic
///
/// Scores worker outputs with structured multi-dimensional evaluation.
/// Triggers adaptive context escalation on low confidence.
/// Never uses binary like/dislike — always structured scoring.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use crate::workers::TaskResult;
use crate::planner::TaskGraph;

pub const CONFIDENCE_THRESHOLD: f32 = 0.65;
pub const MAX_RETRIES: u32 = 3;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TaskEvaluation {
    pub task_id: String,
    pub correctness: f32,
    pub goal_alignment: f32,
    pub efficiency: f32,
    pub ux_impact: f32,
    pub overall: f32,
    pub action: EvalAction,
    pub notes: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum EvalAction {
    Accept,
    RetryWithContext,
    Replan,
    Escalate,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RunEvaluation {
    pub task_evaluations: Vec<TaskEvaluation>,
    pub overall_score: f32,
    pub passed: bool,
    pub summary: String,
}

pub async fn evaluate(results: &[TaskResult], graph: &TaskGraph) -> Result<RunEvaluation> {
    let mut task_evaluations = vec![];

    for result in results {
        let task = graph.tasks.iter().find(|t| t.id == result.task_id);
        let eval = evaluate_task(result, task.map(|t| t.description.as_str()).unwrap_or("")).await?;
        task_evaluations.push(eval);
    }

    let overall_score = if task_evaluations.is_empty() {
        0.0
    } else {
        task_evaluations.iter().map(|e| e.overall).sum::<f32>() / task_evaluations.len() as f32
    };

    let passed = overall_score >= CONFIDENCE_THRESHOLD;

    Ok(RunEvaluation {
        summary: format!(
            "{} tasks evaluated. {} passed threshold.",
            task_evaluations.len(),
            task_evaluations.iter().filter(|e| matches!(e.action, EvalAction::Accept)).count()
        ),
        task_evaluations,
        overall_score,
        passed,
    })
}

async fn evaluate_task(result: &TaskResult, task_description: &str) -> Result<TaskEvaluation> {
    // In v1: use heuristics + confidence passed from worker
    // In v2: call a dedicated critic model

    let base_confidence = result.confidence;

    // Heuristics
    let correctness = base_confidence;
    let goal_alignment = score_goal_alignment(&result.output, task_description);
    let efficiency = score_efficiency(&result.output);
    let ux_impact = 0.7; // placeholder — v2 will derive from persona simulation

    let overall = (correctness + goal_alignment + efficiency + ux_impact) / 4.0;

    let action = determine_action(overall);

    Ok(TaskEvaluation {
        task_id: result.task_id.clone(),
        correctness,
        goal_alignment,
        efficiency,
        ux_impact,
        overall,
        notes: format!("Worker: {}, output_len: {}", result.worker, result.output.len()),
        action,
    })
}

fn score_goal_alignment(output: &str, task_description: &str) -> f32 {
    // Naive keyword overlap — v2 will use embedding similarity
    let task_words: std::collections::HashSet<&str> = task_description.split_whitespace().collect();
    let output_words: std::collections::HashSet<&str> = output.split_whitespace().collect();
    let overlap = task_words.intersection(&output_words).count();
    let ratio = overlap as f32 / task_words.len().max(1) as f32;
    (ratio * 2.0).min(1.0) // scale up, cap at 1.0
}

fn score_efficiency(output: &str) -> f32 {
    // Penalize very short or extremely long outputs
    let len = output.len();
    match len {
        0..=30 => 0.2,
        31..=100 => 0.5,
        101..=2000 => 0.85,
        2001..=5000 => 0.75,
        _ => 0.6, // too verbose
    }
}

fn determine_action(score: f32) -> EvalAction {
    if score >= CONFIDENCE_THRESHOLD {
        EvalAction::Accept
    } else if score >= 0.4 {
        EvalAction::RetryWithContext
    } else if score >= 0.2 {
        EvalAction::Replan
    } else {
        EvalAction::Escalate
    }
}
