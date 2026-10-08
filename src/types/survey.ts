export interface SurveyOption {
  id: string
  label: string
}

export interface SurveyQuestion {
  id: string
  title: string
  options: SurveyOption[]
}

export type SurveyAnswer = { kind: 'option'; optionId: string } | { kind: 'custom'; text: string }

export type SurveyAnswers = Record<string, SurveyAnswer | undefined>
