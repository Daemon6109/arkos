/// Scenario Simulator
///
/// Simulates real user personas interacting with the envisioned product.
/// Derives friction points, confusion zones, and delight moments.
/// Goals are extracted from simulation results — not just from the raw prompt.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use crate::vision::VisionObject;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Persona {
    pub name: String,
    pub description: String,
    pub tech_level: TechLevel,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum TechLevel {
    Novice,
    Hobbyist,
    Developer,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SimulationStep {
    pub step: u32,
    pub action: String,
    pub outcome: String,
    pub friction: u8,  // 0-10
    pub confusion: u8, // 0-10
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PersonaSimulation {
    pub persona: Persona,
    pub steps: Vec<SimulationStep>,
    pub overall_friction: f32,
    pub overall_confusion: f32,
    pub time_to_success: u32,
    pub blockers: Vec<String>,
    pub delights: Vec<String>,
}

pub fn default_personas() -> Vec<Persona> {
    vec![
        Persona {
            name: "novice".to_string(),
            description: "No tech background, first time user. Gets confused easily. Needs hand-holding.".to_string(),
            tech_level: TechLevel::Novice,
        },
        Persona {
            name: "hobbyist".to_string(),
            description: "Some software experience. Can follow instructions but not a developer.".to_string(),
            tech_level: TechLevel::Hobbyist,
        },
        Persona {
            name: "developer".to_string(),
            description: "Technical user. Wants power and control. Hates friction. Reads docs if needed.".to_string(),
            tech_level: TechLevel::Developer,
        },
    ]
}

// TODO: implement in v2
pub async fn simulate(_vision: &VisionObject, _personas: &[Persona]) -> Result<Vec<PersonaSimulation>> {
    // Placeholder — v2 will call LLM with persona + vision to simulate step-by-step interactions
    Ok(vec![])
}
