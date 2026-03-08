/// Vision Generator
/// 
/// Converts a raw goal into a structured design blueprint.
/// The AI forms a mental model of the end product before any execution begins.

use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VisionObject {
    pub name: String,
    pub description: String,
    pub components: Vec<String>,
    pub ux_flow: Vec<String>,
    pub tech_constraints: Vec<String>,
    pub success_metrics: Vec<String>,
    pub raw_vision: String,
}

pub async fn generate(goal: &str) -> Result<VisionObject> {
    let prompt = build_vision_prompt(goal);
    let response = call_ollama(&prompt, "mistral:7b").await?;
    parse_vision_response(&response, goal)
}

fn build_vision_prompt(goal: &str) -> String {
    format!(
        r#"You are a product visionary. Given a goal, you create a structured design blueprint BEFORE any implementation begins.

Goal: {goal}

Think about:
- What is the end product someone would actually experience?
- What are its core components / features?
- What is the UX flow from start to finish?
- What technical constraints apply?
- What defines success for a real human user?

Respond in JSON:
{{
  "name": "short product name",
  "description": "1-2 sentence description",
  "components": ["component1", "component2", ...],
  "ux_flow": ["step 1", "step 2", ...],
  "tech_constraints": ["constraint1", ...],
  "success_metrics": ["metric1", ...]
}}"#
    )
}

async fn call_ollama(prompt: &str, model: &str) -> Result<String> {
    let client = reqwest::Client::new();
    
    let body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": false
    });

    let resp = client
        .post("http://127.0.0.1:11434/api/generate")
        .json(&body)
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;

    Ok(resp["response"].as_str().unwrap_or("").to_string())
}

fn parse_vision_response(response: &str, goal: &str) -> Result<VisionObject> {
    // Try to parse JSON from response
    // LLMs sometimes wrap JSON in ```json ... ``` blocks
    let json_str = extract_json(response);
    
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&json_str) {
        return Ok(VisionObject {
            name: parsed["name"].as_str().unwrap_or(goal).to_string(),
            description: parsed["description"].as_str().unwrap_or("").to_string(),
            components: parse_string_array(&parsed["components"]),
            ux_flow: parse_string_array(&parsed["ux_flow"]),
            tech_constraints: parse_string_array(&parsed["tech_constraints"]),
            success_metrics: parse_string_array(&parsed["success_metrics"]),
            raw_vision: response.to_string(),
        });
    }

    // Fallback: return minimal vision from raw text
    Ok(VisionObject {
        name: goal.to_string(),
        description: response.chars().take(200).collect(),
        components: vec![],
        ux_flow: vec![],
        tech_constraints: vec![],
        success_metrics: vec![],
        raw_vision: response.to_string(),
    })
}

fn extract_json(text: &str) -> String {
    // Strip markdown code fences if present
    if let Some(start) = text.find("```json") {
        if let Some(end) = text[start..].find("```\n") {
            return text[start + 7..start + end].trim().to_string();
        }
    }
    if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            return text[start..=end].to_string();
        }
    }
    text.to_string()
}

fn parse_string_array(val: &serde_json::Value) -> Vec<String> {
    val.as_array()
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default()
}
