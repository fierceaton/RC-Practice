
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import React, { useState, useEffect, useCallback, StrictMode, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';

const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  console.error("API_KEY is not set. Please ensure the API_KEY environment variable is configured.");
}
const ai = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;

const MODEL_TEXT = 'gemini-2.5-flash-preview-04-17';
const QUESTIONS_PER_PASSAGE = 5;
const BASE_TIME_PER_PASSAGE_SECONDS = 15 * 60; 

const LOCAL_STORAGE_KEY_RESULTS = 'catRcTestResults';

// New interfaces for section-wise stats
interface SectionStat {
  mean: number;
  std: number;
}

interface CategorySectionalData {
  VARC: SectionStat;
  LRDI: SectionStat;
  QA: SectionStat;
  TOTAL: SectionStat; // Overall total for the category
}

interface CatSectionalStatsData {
  GENERAL: CategorySectionalData;
  OBC: CategorySectionalData;
  SC: CategorySectionalData;
  ST: CategorySectionalData;
  TOTAL_MARKS_PER_SECTION: number;
  TOTAL_MARKS_OVERALL: number;
}

const CAT_SECTIONAL_STATS: CatSectionalStatsData = {
  GENERAL: {
    VARC: { mean: 36.0, std: 9.98 },
    LRDI: { mean: 34.93, std: 10.0 },
    QA: { mean: 33.99, std: 10.03 },
    TOTAL: { mean: 104.92, std: 17.3 }
  },
  OBC: {
    VARC: { mean: 31.94, std: 9.0 },
    LRDI: { mean: 32.0, std: 9.01 },
    QA: { mean: 31.03, std: 9.02 },
    TOTAL: { mean: 94.98, std: 15.55 }
  },
  SC: {
    VARC: { mean: 28.97, std: 8.01 },
    LRDI: { mean: 28.0, std: 8.03 },
    QA: { mean: 28.03, std: 7.99 },
    TOTAL: { mean: 85.0, std: 13.87 }
  },
  ST: {
    VARC: { mean: 27.03, std: 8.0 },
    LRDI: { mean: 25.95, std: 8.01 },
    QA: { mean: 26.97, std: 8.03 },
    TOTAL: { mean: 79.95, std: 13.92 }
  },
  TOTAL_MARKS_PER_SECTION: 66,
  TOTAL_MARKS_OVERALL: 198
};

// Type for keys that point to CategorySectionalData objects
type UserCategoryKey = keyof Omit<CatSectionalStatsData, 'TOTAL_MARKS_PER_SECTION' | 'TOTAL_MARKS_OVERALL'>;

const USER_CATEGORY: UserCategoryKey = 'OBC'; // User specified OBC

const formatTime = (totalSeconds: number): string => {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

const calculateTotalTestTime = (numPassages: number): number => {
  switch (numPassages) {
    case 1:
      return 15 * 60; 
    case 2:
      return 2 * 12 * 60; 
    case 3:
      return 3 * 10 * 60; 
    case 4:
      return 35 * 60; 
    default:
      console.warn(`Unexpected number of passages (${numPassages}) for time calculation, defaulting.`);
      return BASE_TIME_PER_PASSAGE_SECONDS; 
  }
};


interface Question {
  id: string;
  questionText: string;
  options: string[];
  correctAnswerText: string;
  explanation: string;
  difficultyAssessment: string;
  commonPitfalls: string;
}

interface QuestionState {
  questionId: string;
  selectedOption: string;
  isMarkedForReview: boolean;
  timeSpentOnQuestion: number;
}

interface StoredTestResult {
  id: string;
  dateISO: string;
  score: number;
  totalPossibleScore: number;
  timeTakenSec: number;
  correctCount: number;
  incorrectCount: number;
  unattemptedCount: number;
  passageSummary: string;
  fullPassage: string; 
  rawInputPassages: string[]; 
  questions: Question[];
  questionStates: QuestionState[];
  numberOfPassages: number;
}

type AppState = 'INITIAL_SELECT_PASSAGE_COUNT' | 'INITIAL_INPUT_PASSAGES' | 'PROCESSING' | 'AWAITING_TEST_MODE_CHOICE' | 'TAKING_TEST' | 'VIEWING_RESULTS' | 'ERROR' | 'VIEWING_HISTORY';

const getLocalDateKey = (date: Date): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};


const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>('INITIAL_SELECT_PASSAGE_COUNT');
  const [numberOfPassages, setNumberOfPassages] = useState<number>(1);
  const [currentPassageEntryIndex, setCurrentPassageEntryIndex] = useState<number>(0);
  const [userPassageInputs, setUserPassageInputs] = useState<string[]>([]);
  const [currentPassageInputValue, setCurrentPassageInputValue] = useState<string>('');

  const [combinedFormattedPassages, setCombinedFormattedPassages] = useState<string>('');
  const [questions, setQuestions] = useState<Question[]>([]);
  const [questionStates, setQuestionStates] = useState<QuestionState[]>([]);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState<number>(0);
  
  const [testDurationSeconds, setTestDurationSeconds] = useState<number>(calculateTotalTestTime(1));
  const [timeLeft, setTimeLeft] = useState<number>(testDurationSeconds);
  const [score, setScore] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [allTestResults, setAllTestResults] = useState<StoredTestResult[]>([]);
  const [viewingArchivedTestDetail, setViewingArchivedTestDetail] = useState<StoredTestResult | null>(null);
  
  const timerIntervalId = useRef<number | null>(null);
  const questionTimerStartRef = useRef<number>(0);

  useEffect(() => {
    try {
        const storedResults = localStorage.getItem(LOCAL_STORAGE_KEY_RESULTS);
        if (storedResults) {
            setAllTestResults(JSON.parse(storedResults));
        }
    } catch (e) {
        console.error("Failed to load test results from localStorage:", e);
    }
    
    if (!API_KEY && appState !== 'ERROR') {
        setError("CRITICAL: API_KEY is not configured. This application requires an API_KEY to function. Please set the API_KEY environment variable.");
        setAppState('ERROR');
        setIsLoading(false);
    }
    return () => {
      if (timerIntervalId.current !== null) {
        clearInterval(timerIntervalId.current);
      }
    };
  }, []); 

  useEffect(() => {
    if (allTestResults.length > 0 || localStorage.getItem(LOCAL_STORAGE_KEY_RESULTS)) { 
        try {
            localStorage.setItem(LOCAL_STORAGE_KEY_RESULTS, JSON.stringify(allTestResults));
        } catch (e) {
            console.error("Failed to save test results to localStorage:", e);
            alert(`Error saving test results: ${e instanceof Error ? e.message : String(e)}. Some data might be too large for local storage.`);
        }
    }
  }, [allTestResults]);

  const resetTimer = useCallback(() => {
    if (timerIntervalId.current !== null) {
      clearInterval(timerIntervalId.current);
      timerIntervalId.current = null;
    }
    setTimeLeft(testDurationSeconds); 
  }, [testDurationSeconds]);

  const recordTimeSpentOnCurrentQuestion = useCallback(() => {
    if (appState === 'TAKING_TEST' && questionStates[currentQuestionIndex] && questionTimerStartRef.current > 0) {
      const timeSpent = Math.floor((Date.now() - questionTimerStartRef.current) / 1000);
      setQuestionStates(prevStates => {
        const newStates = [...prevStates];
        if (newStates[currentQuestionIndex]) {
            newStates[currentQuestionIndex].timeSpentOnQuestion += timeSpent;
        }
        return newStates;
      });
    }
    questionTimerStartRef.current = Date.now(); 
  }, [currentQuestionIndex, questionStates, appState]);


  const handleSubmitTest = useCallback(() => {
    recordTimeSpentOnCurrentQuestion(); 
    if (timerIntervalId.current !== null) clearInterval(timerIntervalId.current);
    timerIntervalId.current = null;

    let currentScore = 0;
    questions.forEach((question, index) => {
      const state = questionStates[index];
      if (state && state.selectedOption) {
        if (state.selectedOption === question.correctAnswerText) {
          currentScore += 3;
        } else {
          currentScore -= 1; // Assuming negative marking
        }
      }
    });
    setScore(currentScore);

    const correctCount = questionStates.filter((qs, i) => qs.selectedOption && qs.selectedOption === questions[i].correctAnswerText).length;
    const incorrectCount = questionStates.filter((qs, i) => qs.selectedOption && qs.selectedOption !== questions[i].correctAnswerText).length;
    const unattemptedCount = questionStates.filter(qs => !qs.selectedOption).length;
    const timeTaken = testDurationSeconds - timeLeft;

    const passageSummaryText = numberOfPassages > 1 
        ? `${numberOfPassages} passages. First: ${combinedFormattedPassages.substring(0, 75)}...`
        : combinedFormattedPassages.substring(0, 100) + (combinedFormattedPassages.length > 100 ? "..." : "");


    const newResult: StoredTestResult = {
        id: new Date().toISOString() + Math.random().toString(36).substring(2,9), 
        dateISO: new Date().toISOString(),
        score: currentScore,
        totalPossibleScore: questions.length * 3,
        timeTakenSec: timeTaken,
        correctCount: correctCount,
        incorrectCount: incorrectCount,
        unattemptedCount: unattemptedCount,
        passageSummary: passageSummaryText,
        fullPassage: combinedFormattedPassages, 
        rawInputPassages: userPassageInputs, 
        questions: questions,        
        questionStates: questionStates,
        numberOfPassages: numberOfPassages
    };
    setAllTestResults(prevResults => [...prevResults, newResult]);
    setAppState('VIEWING_RESULTS');
  }, [questions, questionStates, recordTimeSpentOnCurrentQuestion, timeLeft, combinedFormattedPassages, testDurationSeconds, numberOfPassages, userPassageInputs]);

  const startTestTimer = useCallback(() => {
    resetTimer(); 
    questionTimerStartRef.current = Date.now(); 
    timerIntervalId.current = setInterval(() => {
      setTimeLeft(prevTime => {
        if (prevTime <= 1) {
          if (timerIntervalId.current !== null) clearInterval(timerIntervalId.current);
          timerIntervalId.current = null; 
          handleSubmitTest(); 
          return 0;
        }
        return prevTime - 1;
      });
    }, 1000) as unknown as number;
  }, [resetTimer, handleSubmitTest]);

  const handleReattemptTest = (testToReattempt: StoredTestResult) => {
    setCombinedFormattedPassages(testToReattempt.fullPassage);
    setQuestions(testToReattempt.questions);
    setNumberOfPassages(testToReattempt.numberOfPassages); 
    setUserPassageInputs(testToReattempt.rawInputPassages); 
    
    const duration = calculateTotalTestTime(testToReattempt.numberOfPassages);
    setTestDurationSeconds(duration);
    setTimeLeft(duration);

    const newAttemptQuestionStates = testToReattempt.questions.map(q => ({
        questionId: q.id,
        selectedOption: '',
        isMarkedForReview: false,
        timeSpentOnQuestion: 0
    }));
    setQuestionStates(newAttemptQuestionStates);
    
    setCurrentQuestionIndex(0);
    setError(null);
    setScore(0); 
    
    setViewingArchivedTestDetail(null); 
    setAppState('TAKING_TEST');
    Promise.resolve().then(() => {
        startTestTimer();
    });
  };

  const handleProceedToPassageInput = () => {
    const duration = calculateTotalTestTime(numberOfPassages);
    setTestDurationSeconds(duration);
    setTimeLeft(duration);
    setUserPassageInputs(new Array(numberOfPassages).fill(''));
    setCurrentPassageEntryIndex(0);
    setCurrentPassageInputValue('');
    setError(null); 
    setAppState('INITIAL_INPUT_PASSAGES');
  };

  const handleNextPassage = () => {
    const updatedPassages = [...userPassageInputs];
    updatedPassages[currentPassageEntryIndex] = currentPassageInputValue;
    setUserPassageInputs(updatedPassages);

    if (currentPassageEntryIndex < numberOfPassages - 1) {
      setCurrentPassageEntryIndex(prev => prev + 1);
      setCurrentPassageInputValue(userPassageInputs[currentPassageEntryIndex + 1] || '');
    } else {
      handleAllPassagesSubmit(updatedPassages);
    }
  };

  const handleAllPassagesSubmit = async (finalPassages: string[]) => {
    if (finalPassages.some(p => !p.trim())) {
      setError(`Please ensure all ${numberOfPassages} passages are entered.`);
      return;
    }

    for (let i = 0; i < finalPassages.length; i++) {
      const newPassageTrimmed = finalPassages[i].trim();
      for (const storedResult of allTestResults) {
        if (storedResult.rawInputPassages) {
          for (const storedRawPassage of storedResult.rawInputPassages) {
            if (storedRawPassage.trim() === newPassageTrimmed) {
              const passageDate = new Date(storedResult.dateISO).toLocaleDateString();
              setError(`Passage ${i + 1} ("${newPassageTrimmed.substring(0, 50)}...") appears to be a duplicate of a passage from a test taken on ${passageDate}. Please provide a new passage.`);
              setAppState('INITIAL_INPUT_PASSAGES'); 
              return;
            }
          }
        }
      }
    }
    
    if (!ai) {
        setError("API Client not initialized. API_KEY might be missing or invalid.");
        setAppState('ERROR');
        setIsLoading(false);
        return;
    }
    setIsLoading(true);
    setError(null);
    setAppState('PROCESSING');

    try {
      const formattedPassagesArray = await Promise.all(
        finalPassages.map(async (passageText, index) => {
          const passageResponse: GenerateContentResponse = await ai.models.generateContent({
            model: MODEL_TEXT,
            contents: `Please reformat the following passage (Passage ${index + 1} of ${finalPassages.length}) for optimal readability. Ensure paragraphs are well-defined, remove any redundant spacing or unconventional formatting, and present it as clean text suitable for a reading comprehension exercise:\n\n${passageText}`,
          });
          return passageResponse.text;
        })
      );
      
      const combined = formattedPassagesArray.map((fp, i) => `[START OF PASSAGE ${i + 1}]\n${fp}\n[END OF PASSAGE ${i + 1}]`).join('\n\n---\n\n');
      setCombinedFormattedPassages(combined);
      setUserPassageInputs(finalPassages); 

      const totalExpectedQuestions = numberOfPassages * QUESTIONS_PER_PASSAGE;

      const questionsPrompt = `
You are an expert AI assistant specializing in creating high-quality verbal reasoning questions for competitive entrance exams like CAT (Common Admission Test) and GMAT.
Based on the provided passage(s), generate EXACTLY ${totalExpectedQuestions} multiple-choice questions (MCQs).
These questions should rigorously test critical reading and analytical skills, comparable in style and difficulty to those found in the CAT and GMAT verbal sections.

Ensure a diverse mix of question types, including but not limited to:
- Main Idea / Primary Purpose of the passage(s) or specific paragraphs.
- Inference: Questions that require deducing information not explicitly stated.
- Supporting Idea / Specific Detail: Questions about explicitly stated facts or arguments.
- Application: Questions that ask to apply information from the passage to new, hypothetical situations.
- Logical Structure / Organization: Questions about how the passage is constructed or the relationship between parts.
- Author's Tone / Attitude / Style: Questions about the author's perspective or writing style.
- Vocabulary-in-Context: Questions about the meaning of specific words or phrases as used in the passage.
- Weaken/Strengthen: If a passage presents an argument, include questions that ask to weaken or strengthen it.

The difficulty should be challenging, suitable for aspirants of top-tier MBA programs.
Distractor options (incorrect answers) must be plausible and sophisticated, designed to mislead test-takers who have a superficial understanding of the passage. Avoid overly simplistic or obviously wrong distractors.
Correct answers should be unambiguously supported by the passage text or logical inference from it.

YOUR RESPONSE MUST BE A SINGLE, VALID JSON ARRAY.
THIS ARRAY MUST CONTAIN EXACTLY ${totalExpectedQuestions} JSON OBJECTS, ONE FOR EACH QUESTION.
NO OTHER TEXT, MARKDOWN (like \`\`\`json\`), OR EXPLANATIONS OUTSIDE THIS JSON ARRAY.

JSON FORMATTING RULES:
1. The entire response MUST start with an opening square bracket '[' and end with a closing square bracket ']'.
2. Each element in the array is a JSON object representing one question.
3. Question objects within the array MUST be separated by a comma.
4. There MUST NOT be a comma after the LAST question object in the array.
5. All property names (keys) within each JSON object MUST be enclosed in double quotes (e.g., "questionText").
6. All string values within each JSON object MUST be enclosed in double quotes. Ensure any double quotes *within* a string value are properly escaped (e.g., "He said, \\"Hello\\".").

EXAMPLE OF JSON STRUCTURE:

If you need to generate 2 questions (i.e., ${totalExpectedQuestions} is 2), the structure should be:
[
  {
    "questionText": "Sample question text for question 1...",
    "options": ["Option A for Q1", "Option B for Q1", "Option C for Q1", "Option D for Q1"],
    "correctAnswerText": "Option B for Q1",
    "explanation": "Detailed explanation for why Option B is correct for Q1...",
    "difficultyAssessment": "CAT-Hard (85-95th percentile)",
    "commonPitfalls": "Common pitfall for Q1 (e.g., 'Focusing on a minor detail')."
  },
  {
    "questionText": "Sample question text for question 2...",
    "options": ["Option A for Q2", "Option B for Q2", "Option C for Q2", "Option D for Q2"],
    "correctAnswerText": "Option C for Q2",
    "explanation": "Detailed explanation for why Option C is correct for Q2...",
    "difficultyAssessment": "GMAT 700+ level",
    "commonPitfalls": "Common pitfall for Q2 (e.g., 'Misinterpreting quantifier')."
  }
]

If you need to generate 1 question (i.e., ${totalExpectedQuestions} is 1), the structure should be:
[
  {
    "questionText": "Sample question text for question 1...",
    "options": ["Option A for Q1", "Option B for Q1", "Option C for Q1", "Option D for Q1"],
    "correctAnswerText": "Option A for Q1",
    "explanation": "Detailed explanation for why Option A is correct for Q1...",
    "difficultyAssessment": "CAT-Medium (75-85th percentile)",
    "commonPitfalls": "Common pitfall for Q1 (e.g., 'Ignoring passage scope')."
  }
]

(Adjust the number of objects in the array based on the required ${totalExpectedQuestions}.)

EACH QUESTION OBJECT MUST ADHERE TO THE FOLLOWING STRUCTURE AND CONTENT REQUIREMENTS:
{
  "questionText": "A non-empty, clear, and concise question related to the passage(s).",
  "options": ["Non-empty Option A text", "Non-empty Option B text", "Non-empty Option C text", "Non-empty Option D text"],
  "correctAnswerText": "The non-empty text of the correct option. This MUST exactly match one of the four strings provided in the 'options' array.",
  "explanation": "A non-empty, detailed explanation of why the correct answer is correct and why other options might be incorrect, relating directly to the passage(s).",
  "difficultyAssessment": "A non-empty assessment (e.g., 'CAT-Medium (75-85th percentile)', 'GMAT 700+ level'). Be specific about target exam and level.",
  "commonPitfalls": "Non-empty, specific reasons students might get this question wrong, focusing on CAT/GMAT traps (e.g., 'Misinterpreting scope', 'Over-generalizing')."
}

CRITICAL FIELD REQUIREMENTS FOR EACH QUESTION OBJECT:
1.  "questionText": Must be a non-empty string.
2.  "options": Must be an array of EXACTLY FOUR (4) non-empty strings.
3.  "correctAnswerText": Must be a non-empty string that EXACTLY matches one of the strings in the "options" array.
4.  "explanation": Must be a non-empty string.
5.  "difficultyAssessment": Must be a non-empty string.
6.  "commonPitfalls": Must be a non-empty string.
All listed fields are MANDATORY for each of the ${totalExpectedQuestions} questions. Ensure all string values are properly double-quoted and any internal quotes are escaped.

Passage(s):
---
${combined}
---
Final reminder: Your output must be *only* the valid JSON array as described. Double-check all quotes, commas, and brackets.
`;
      
      const questionsResponse: GenerateContentResponse = await ai.models.generateContent({
        model: MODEL_TEXT,
        contents: questionsPrompt,
        config: { 
            responseMimeType: "application/json",
            systemInstruction: "You are an expert test designer for competitive exams like CAT and GMAT. Your primary goal is to create challenging and insightful multiple-choice questions based on provided reading comprehension passages, adhering strictly to the user's formatting and content requirements."
        }
      });
      
      let jsonStr = questionsResponse.text.trim();
      const fenceRegex = /^```(\w*)?\s*\n?(.*?)\n?\s*```$/s;
      const match = jsonStr.match(fenceRegex);
      if (match && match[2]) {
        jsonStr = match[2].trim();
      }

      const parsedQuestions: Omit<Question, 'id'>[] = JSON.parse(jsonStr);
       if (!Array.isArray(parsedQuestions) || parsedQuestions.length === 0 || parsedQuestions.length !== totalExpectedQuestions) {
        throw new Error(`Generated questions are not in the expected format or count. Expected ${totalExpectedQuestions} questions, got ${parsedQuestions?.length || 0}. Response: ${jsonStr.substring(0, 500)}`);
      }
      
      const questionsWithIds = parsedQuestions.map((q, index) => {
        const optionsAreValid = Array.isArray(q.options) && 
                                q.options.length === 4 && 
                                q.options.every(opt => typeof opt === 'string' && opt.trim() !== '');

        if (!q.questionText || !q.questionText.trim() ||
            !optionsAreValid ||
            !q.correctAnswerText || !q.correctAnswerText.trim() ||
            !q.options.includes(q.correctAnswerText) || 
            !q.explanation || !q.explanation.trim() ||
            !q.difficultyAssessment || !q.difficultyAssessment.trim() ||
            !q.commonPitfalls || !q.commonPitfalls.trim()) {
            console.error("Invalid question structure from AI. Problematic question object:", JSON.stringify(q, null, 2));
            throw new Error("One or more generated questions have an invalid structure or missing/empty required fields (questionText, options array of 4 non-empty strings, correctAnswerText, explanation, difficultyAssessment, commonPitfalls), or correctAnswerText is not in options.");
        }
        return { ...q, id: `q-${index}-${Date.now()}` }; 
      });
      setQuestions(questionsWithIds);
      setQuestionStates(questionsWithIds.map(q => ({ 
        questionId: q.id, 
        selectedOption: '', 
        isMarkedForReview: false, 
        timeSpentOnQuestion: 0 
      })));
      setCurrentQuestionIndex(0);
      setAppState('AWAITING_TEST_MODE_CHOICE'); 

    } catch (e) {
      console.error("Error processing passage(s) or generating questions:", e);
      let detailedErrorMessage = e instanceof Error ? e.message : String(e);
      if (e instanceof SyntaxError && e.message.includes("JSON")) { 
        detailedErrorMessage += ` (This often means the AI's response was not perfectly formatted JSON. Error details: ${e.message})`;
      }
      setError(`Failed to process passage(s) or generate questions. Please check the passage(s) or try again. Details: ${detailedErrorMessage}`);
      setAppState('ERROR');
    } finally {
      setIsLoading(false);
    }
  };

  const handleStartOnlineTest = () => {
    setAppState('TAKING_TEST');
    Promise.resolve().then(() => {
        startTestTimer();
    });
  };
  
  const handleDownloadHTMLTest = () => {
    const htmlContent = generateOfflineTestHTML(combinedFormattedPassages, questions, testDurationSeconds);
    const blob = new Blob([htmlContent], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cat_rc_practice_test.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    alert("Test HTML file downloaded! You can open it in your browser to take the test offline. You can also still take the test online here.");
  };


  const handleAnswerSelection = (option: string) => {
    setQuestionStates(prevStates => {
      const newStates = [...prevStates];
      if(newStates[currentQuestionIndex]) { 
          newStates[currentQuestionIndex].selectedOption = option;
      }
      return newStates;
    });
  };
  
  const handleSaveAnswer = () => {
    alert("Answer recorded! Your selection is saved as you click it."); 
  };

  const handleMarkForReview = () => {
    setQuestionStates(prevStates => {
      const newStates = [...prevStates];
       if(newStates[currentQuestionIndex]) {
          newStates[currentQuestionIndex].isMarkedForReview = !newStates[currentQuestionIndex].isMarkedForReview;
       }
      return newStates;
    });
  };

  const handleNavigateQuestion = (direction: 'next' | 'prev' | 'jump', index?: number) => {
    recordTimeSpentOnCurrentQuestion();
    if (direction === 'next') {
      if (currentQuestionIndex < questions.length - 1) {
        setCurrentQuestionIndex(currentQuestionIndex + 1);
      }
    } else if (direction === 'prev') {
      if (currentQuestionIndex > 0) {
        setCurrentQuestionIndex(currentQuestionIndex - 1);
      }
    } else if (direction === 'jump' && index !== undefined) {
      if (index >= 0 && index < questions.length) {
        setCurrentQuestionIndex(index);
      }
    }
  };


  const handleStartNewTest = () => {
    setAppState('INITIAL_SELECT_PASSAGE_COUNT');
    setNumberOfPassages(1); 
    setCurrentPassageEntryIndex(0);
    setUserPassageInputs([]);
    setCurrentPassageInputValue('');
    setCombinedFormattedPassages('');
    setQuestions([]);
    setQuestionStates([]);
    setCurrentQuestionIndex(0);
    const initialDuration = calculateTotalTestTime(1); 
    setTestDurationSeconds(initialDuration);
    resetTimer();
    setScore(0);
    setError(null);
    setIsLoading(false); 
    setViewingArchivedTestDetail(null); 
    
    if (!API_KEY) { 
        setError("CRITICAL: API_KEY is not configured. This application requires an API_KEY to function. Please set the API_KEY environment variable.");
        setAppState('ERROR');
    }
  };
  
  const currentQuestion = questions[currentQuestionIndex];
  const currentQuestionState = questionStates[currentQuestionIndex];

  if (isLoading) {
    return (
      <div className="app-container">
        <header className="header"><h1>CAT RC Practice Zone</h1></header>
        <div className="loading-container" role="alert" aria-live="assertive">
          <p>Processing your passage(s) and generating questions... Please wait.</p>
          <div className="spinner"></div>
        </div>
      </div>
    );
  }

  if (appState === 'ERROR' && error) {
    return (
      <div className="app-container">
        <header className="header"><h1>CAT RC Practice Zone</h1></header>
        <div className="error-container" role="alert">
          <h2>An Error Occurred</h2>
          <p className="error-message-text">{error}</p>
          <button 
            onClick={appState === 'ERROR' && error?.includes("duplicate") ? handleProceedToPassageInput : handleStartNewTest} 
            className="error-button"
          >
            {error?.includes("duplicate") ? "Back to Edit Passages" : "Try Again / Start Over"}
          </button>
        </div>
      </div>
    );
  }

  if (viewingArchivedTestDetail) {
    return <ArchivedTestDetailView 
                testData={viewingArchivedTestDetail} 
                onBack={() => {
                  setViewingArchivedTestDetail(null);
                  if (appState !== 'VIEWING_HISTORY') setAppState('VIEWING_HISTORY'); 
                }} 
                onReattempt={handleReattemptTest} 
            />;
  }
  
  if (appState === 'VIEWING_HISTORY') {
    return <TestHistoryView 
              results={allTestResults} 
              onBack={handleStartNewTest} 
              onSelectTestForDetails={setViewingArchivedTestDetail}
            />;
  }

  return (
    <div className="app-container">
      <header className="header">
        <h1>CAT RC Practice Zone</h1>
      </header>

      {appState === 'INITIAL_SELECT_PASSAGE_COUNT' && (
        <div className="passage-input-container">
          <h2>Configure Your Practice Test</h2>
          <div className="passage-count-selector">
            <label htmlFor="passage-count">How many passages will you practice with? (1-4)</label>
            <select 
              id="passage-count"
              value={numberOfPassages} 
              onChange={(e) => {
                  const num = Number(e.target.value);
                  setNumberOfPassages(num);
                  setTestDurationSeconds(calculateTotalTestTime(num)); 
              }}
              aria-label="Select number of passages"
            >
              <option value={1}>1 Passage</option>
              <option value={2}>2 Passages</option>
              <option value={3}>3 Passages</option>
              <option value={4}>4 Passages</option>
            </select>
          </div>
          <p className="info-text">
            The test will have {QUESTIONS_PER_PASSAGE} CAT/GMAT-level MCQs per passage.
            Total time: {formatTime(calculateTotalTestTime(numberOfPassages))}.
          </p>
          <button onClick={handleProceedToPassageInput} disabled={!API_KEY || isLoading}>
            Proceed to Enter Passages
          </button>
          {!API_KEY && <p className="api-key-warning">CRITICAL: API Key not configured. The application cannot function.</p>}
           {allTestResults.length > 0 && (
            <button 
              onClick={() => setAppState('VIEWING_HISTORY')} 
              className="history-button"
              aria-label="View your past test results and analysis"
            >
                View Test History
            </button>
           )}
        </div>
      )}

      {appState === 'INITIAL_INPUT_PASSAGES' && (
         <div className="passage-input-container">
            <h2>Enter Passage {currentPassageEntryIndex + 1} of {numberOfPassages}</h2>
            {error && <p className="error-message-text inline-error">{error}</p>}
            <textarea
                id={`passage-input-${currentPassageEntryIndex}`}
                value={currentPassageInputValue}
                onChange={(e) => {
                    setCurrentPassageInputValue(e.target.value);
                    if (error) setError(null); 
                }}
                placeholder={`Paste passage ${currentPassageEntryIndex + 1} here...`}
                aria-label={`Passage input area for passage ${currentPassageEntryIndex + 1}`}
                rows={15}
                disabled={!API_KEY || isLoading}
            />
            {currentPassageEntryIndex > 0 && (
                <button 
                    onClick={() => {
                        const updatedPassages = [...userPassageInputs];
                        updatedPassages[currentPassageEntryIndex] = currentPassageInputValue; 
                        setUserPassageInputs(updatedPassages);
                        setCurrentPassageEntryIndex(prev => prev - 1);
                        setCurrentPassageInputValue(userPassageInputs[currentPassageEntryIndex - 1] || '');
                        if (error) setError(null);
                    }}
                    className="button-secondary" 
                    style={{marginRight: '10px'}}
                >
                    Previous Passage
                </button>
            )}
            <button 
                onClick={() => {
                    const finalPassages = [...userPassageInputs];
                    finalPassages[currentPassageEntryIndex] = currentPassageInputValue;
                    if (currentPassageEntryIndex < numberOfPassages - 1) {
                        handleNextPassage();
                    } else {
                        handleAllPassagesSubmit(finalPassages);
                    }
                }} 
                disabled={!currentPassageInputValue.trim() || !API_KEY || isLoading}
            >
                {isLoading ? 'Processing...' : 
                    (currentPassageEntryIndex < numberOfPassages - 1 ? 'Save and Next Passage' : 'Generate Questions')}
            </button>
            <button onClick={handleStartNewTest} className="start-new-test-button small-button" style={{marginTop: '15px'}}>
                Start Over (New Config)
            </button>
         </div>
      )}


      {appState === 'AWAITING_TEST_MODE_CHOICE' && (
        <div className="test-mode-choice-container">
            <h2>Questions Generated!</h2>
            <p>Your passage(s) have been processed and {questions.length} CAT/GMAT-level questions are ready.</p>
            <p>Total test time: {formatTime(testDurationSeconds)}.</p>
            <p>How would you like to take the test?</p>
            <div className="test-mode-buttons">
                <button onClick={handleStartOnlineTest} className="online-test-button">Start Test Online</button>
                <button onClick={handleDownloadHTMLTest} className="download-test-button">Download Test (HTML for Offline)</button>
            </div>
            <button onClick={handleStartNewTest} className="start-new-test-button small-button">Start with New Configuration</button>
        </div>
      )}

      {appState === 'TAKING_TEST' && currentQuestion && currentQuestionState && (
        <div className="test-environment">
          <div className="test-main-area">
            <div className="passage-display-test">
                <h3>Reading Passage(s)</h3>
                <div dangerouslySetInnerHTML={{ __html: combinedFormattedPassages.replace(/\n/g, '<br />') }} />
            </div>
            <div className="question-display-area">
                <h3>Question {currentQuestionIndex + 1} of {questions.length}</h3>
                <p className="question-text-bold">{currentQuestion.questionText}</p>
                <fieldset className="options-fieldset" role="radiogroup" aria-labelledby={`question-text-${currentQuestion.id}`}>
                    <legend id={`question-text-${currentQuestion.id}`} className="sr-only">Question {currentQuestionIndex + 1}: {currentQuestion.questionText}</legend>
                    <ul className="options-list">
                        {currentQuestion.options.map((option, optIndex) => (
                        <li key={optIndex}>
                            <label>
                            <input
                                type="radio"
                                name={currentQuestion.id}
                                value={option}
                                checked={currentQuestionState.selectedOption === option}
                                onChange={() => handleAnswerSelection(option)}
                                aria-labelledby={`question-text-${currentQuestion.id} option-text-${currentQuestion.id}-${optIndex}`}
                            />
                            <span id={`option-text-${currentQuestion.id}-${optIndex}`}>{option}</span>
                            </label>
                        </li>
                        ))}
                    </ul>
                </fieldset>
                <div className="question-actions">
                    <button onClick={handleSaveAnswer} disabled={!currentQuestionState.selectedOption} aria-live="polite">
                        {currentQuestionState.selectedOption ? "Answer Recorded" : "Select an Answer"}
                    </button>
                    <button onClick={handleMarkForReview} className={currentQuestionState.isMarkedForReview ? 'marked-for-review-active' : ''}>
                        {currentQuestionState.isMarkedForReview ? 'Unmark Review' : 'Mark for Review'}
                    </button>
                </div>
                <div className="question-navigation-buttons">
                    <button onClick={() => handleNavigateQuestion('prev')} disabled={currentQuestionIndex === 0}>
                    Previous
                    </button>
                    <button onClick={() => handleNavigateQuestion('next')} disabled={currentQuestionIndex === questions.length - 1}>
                    Next
                    </button>
                </div>
            </div>
          </div>
          <div className="question-navigation-panel">
            <h3>Questions</h3>
            <div className="timer-display test-timer" role="timer" aria-live="polite">
                Time Left: {formatTime(timeLeft)}
            </div>
            <ul className="question-status-list">
              {questions.map((q, index) => (
                <li key={q.id}
                    className={`
                      question-status-item 
                      ${index === currentQuestionIndex ? 'active' : ''}
                      ${questionStates[index]?.selectedOption ? 'answered' : 'unanswered'}
                      ${questionStates[index]?.isMarkedForReview ? 'review' : ''}
                    `}
                    onClick={() => handleNavigateQuestion('jump', index)}
                    onKeyDown={(e) => e.key === 'Enter' && handleNavigateQuestion('jump', index)}
                    tabIndex={0}
                    role="button"
                    aria-label={`Go to question ${index + 1}. Status: ${questionStates[index]?.selectedOption ? 'Answered.' : 'Unanswered.'} ${questionStates[index]?.isMarkedForReview ? 'Marked for review.' : ''}`}
                >
                  Q{index + 1}
                </li>
              ))}
            </ul>
             <button onClick={handleSubmitTest} className="submit-test-button-main">Submit Test</button>
          </div>
        </div>
      )}

      {appState === 'VIEWING_RESULTS' && (
        <div className="results-container">
          <div className="results-summary">
            <h2>Test Results</h2>
            <p>Your Final Score: {score} / {questions.length * 3}</p>
            <div className="overall-analysis">
                <p>Total Questions: {questions.length} ({numberOfPassages} passage{numberOfPassages > 1 ? 's' : ''})</p>
                <p>Correct: {questionStates.filter((qs, i) => qs.selectedOption && qs.selectedOption === questions[i].correctAnswerText).length}</p>
                <p>Incorrect: {questionStates.filter((qs, i) => qs.selectedOption && qs.selectedOption !== questions[i].correctAnswerText).length}</p>
                <p>Unattempted: {questionStates.filter(qs => !qs.selectedOption).length}</p>
                <p>Total Time Spent: {formatTime(testDurationSeconds - timeLeft)} / {formatTime(testDurationSeconds)}</p>
            </div>
          </div>

          <PerformanceAnalysisCard userScore={score} totalPossibleScore={questions.length * 3} />

          <h3>Detailed Answer Review:</h3>
          {questions.map((q, index) => {
            const qState = questionStates[index];
            const userAnswer = qState.selectedOption;
            const isCorrect = userAnswer === q.correctAnswerText;
            const isAttempted = userAnswer && userAnswer !== '';

            return (
              <div key={q.id} className="result-question-item detailed">
                <h4>Question {index + 1}: {q.questionText}</h4>
                <ul className="result-options-list">
                  {q.options.map((option, optIndex) => (
                    <li
                      key={optIndex}
                      className={`
                        ${option === q.correctAnswerText ? 'correct-answer-highlight' : ''}
                        ${option === userAnswer ? (isCorrect ? 'user-selected user-correct' : 'user-selected user-incorrect') : ''}
                      `}
                       aria-label={`Option: ${option}${option === q.correctAnswerText ? '. Correct answer.' : ''}${option === userAnswer ? (isCorrect ? ' You selected this. Correct.' : ' You selected this. Incorrect.') : ''}`}
                    >
                      {option}
                      {option === q.correctAnswerText && userAnswer === option && <span className="status-icon correct"> ✔ Your Answer (Correct)</span>}
                      {option !== q.correctAnswerText && userAnswer === option && <span className="status-icon incorrect"> ✘ Your Answer (Incorrect)</span>}
                      {option === q.correctAnswerText && (!userAnswer || userAnswer !== option) && <span className="status-icon correct-only"> ✔ Correct Answer</span>}
                    </li>
                  ))}
                </ul>
                {!isAttempted && <p className="not-attempted-feedback"><em>Not Attempted. Correct answer was: {q.correctAnswerText}</em></p>}
                
                <div className="result-analysis-section">
                    <p><strong>Your Answer:</strong> {userAnswer || "Not Attempted"}</p>
                    <p><strong>Correct Answer:</strong> {q.correctAnswerText}</p>
                    <p><strong>Time Spent:</strong> {formatTime(qState.timeSpentOnQuestion)}</p>
                    <div className="explanation-box">
                        <strong>Explanation:</strong>
                        <p>{q.explanation}</p>
                    </div>
                     <div className="ai-insights-box">
                        <strong>AI Insights:</strong>
                        <p><em>Difficulty:</em> {q.difficultyAssessment}</p>
                        <p><em>Common Pitfalls:</em> {q.commonPitfalls}</p>
                    </div>
                </div>
              </div>
            );
          })}
          <div className="results-actions">
            <button onClick={handleStartNewTest} className="start-new-test-button">Start New Test Config</button>
            {allTestResults.length > 0 && (
                <button onClick={() => setAppState('VIEWING_HISTORY')} className="history-button">
                    View Test History
                </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

interface PerformanceAnalysisCardProps {
    userScore: number;
    totalPossibleScore: number;
}
const PerformanceAnalysisCard: React.FC<PerformanceAnalysisCardProps> = ({ userScore, totalPossibleScore }) => {
    if (totalPossibleScore === 0) {
        return (
            <div className="performance-analysis-card">
                <h3>Comparative Performance Analysis (CAT VARC Section)</h3>
                <p>Analysis not available as no questions were scored.</p>
            </div>
        );
    }

    // Project score to VARC section (out of 66)
    const projectedVarcScore = parseFloat(
        ((userScore / totalPossibleScore) * CAT_SECTIONAL_STATS.TOTAL_MARKS_PER_SECTION).toFixed(2)
    );
    
    const categoryVarcData = CAT_SECTIONAL_STATS[USER_CATEGORY].VARC;
    const mean = categoryVarcData.mean;
    const stdDev = categoryVarcData.std;
    const lowerBound = parseFloat((mean - stdDev).toFixed(2));
    const upperBound = parseFloat((mean + stdDev).toFixed(2));

    let comparisonStatement = "";
    if (projectedVarcScore > upperBound) {
        comparisonStatement = `Your projected VARC score of ${projectedVarcScore} is above the typical range for the ${USER_CATEGORY} category's VARC section.`;
    } else if (projectedVarcScore < lowerBound) {
        comparisonStatement = `Your projected VARC score of ${projectedVarcScore} is below the typical range for the ${USER_CATEGORY} category's VARC section.`;
    } else if (projectedVarcScore > mean) {
        comparisonStatement = `Your projected VARC score of ${projectedVarcScore} is above the average and within the typical range for the ${USER_CATEGORY} category's VARC section.`;
    } else if (projectedVarcScore < mean) {
        comparisonStatement = `Your projected VARC score of ${projectedVarcScore} is below the average but within the typical range for the ${USER_CATEGORY} category's VARC section.`;
    } else {
        comparisonStatement = `Your projected VARC score of ${projectedVarcScore} is around the average for the ${USER_CATEGORY} category's VARC section.`;
    }
    
    return (
        <div className="performance-analysis-card">
            <h3>Comparative Performance Analysis (vs. CAT {USER_CATEGORY} VARC Data)</h3>
            <div className="analysis-data-grid">
                <p><strong>Your Practice Test Score (RC focused):</strong> {userScore} / {totalPossibleScore}</p>
                <p><strong>Projected CAT VARC Section Score (out of {CAT_SECTIONAL_STATS.TOTAL_MARKS_PER_SECTION}):</strong> {projectedVarcScore}</p>
                <p><strong>{USER_CATEGORY} Category VARC Average (Mean):</strong> ~{mean.toFixed(2)}</p>
                <p><strong>{USER_CATEGORY} Category VARC Std. Deviation:</strong> ~{stdDev.toFixed(2)}</p>
                <p><strong>{USER_CATEGORY} Typical VARC Score Range (Mean ± 1 Std Dev):</strong> ~{lowerBound} to ~{upperBound}</p>
            </div>
            <p className="analysis-interpretation">{comparisonStatement}</p>
            <p className="analysis-disclaimer">
                <strong>Disclaimer:</strong> This is an illustrative comparison based on simulated statistical data for the VARC section. 
                Performance in this RC-focused practice set may not directly reflect your score on the full CAT VARC section or overall exam, 
                which test a broader range of skills under different conditions. Use this as one of several tools for preparation.
            </p>
        </div>
    );
};


interface TestHistoryViewProps {
    results: StoredTestResult[];
    onBack: () => void;
    onSelectTestForDetails: (test: StoredTestResult) => void;
}

const TestHistoryView: React.FC<TestHistoryViewProps> = ({ results, onBack, onSelectTestForDetails }) => {
    const [displayDate, setDisplayDate] = useState(new Date()); 
    const [selectedDateKey, setSelectedDateKey] = useState<string | null>(null); 

    const testsByDate = useMemo(() => {
        return results.reduce((acc, result) => {
            const localTestDate = new Date(result.dateISO); 
            const dateKey = getLocalDateKey(localTestDate); 
            if (!acc[dateKey]) {
                acc[dateKey] = [];
            }
            acc[dateKey].push(result);
            return acc;
        }, {} as Record<string, StoredTestResult[]>);
    }, [results]);

    const changeMonth = (offset: number) => {
        setDisplayDate(prev => {
            const newDate = new Date(prev);
            newDate.setMonth(newDate.getMonth() + offset);
            newDate.setDate(1); 
            return newDate;
        });
        setSelectedDateKey(null); 
    };

    const year = displayDate.getFullYear();
    const month = displayDate.getMonth(); 

    const firstDayOfMonth = new Date(year, month, 1).getDay(); 
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const calendarDays: (Date | null)[] = [];
    for (let i = 0; i < firstDayOfMonth; i++) {
        calendarDays.push(null);
    }
    for (let i = 1; i <= daysInMonth; i++) {
        calendarDays.push(new Date(year, month, i)); 
    }
    
    const handleDayClick = (date: Date | null) => {
        if (date) {
            const localClickedDateKey = getLocalDateKey(date); 
            setSelectedDateKey(localClickedDateKey); 
        } else {
            setSelectedDateKey(null);
        }
    };
    
    const selectedTests = selectedDateKey ? testsByDate[selectedDateKey] || [] : [];

    const getFormattedSelectedDateHeader = (): string => {
        if (!selectedDateKey) return "";
        const [sYear, sMonth, sDay] = selectedDateKey.split('-').map(Number);
        const dateForFormatting = new Date(sYear, sMonth - 1, sDay); 
        return dateForFormatting.toLocaleDateString('default', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    };


    return (
        <div className="history-container">
            <header className="header">
                 <h1>Test History & Analysis</h1>
            </header>
            <button onClick={onBack} className="back-button" aria-label="Go back to the main application screen">Back to Main</button>

            <div className="calendar-top-panel">
                <div className="calendar-controls">
                    <button onClick={() => changeMonth(-1)} aria-label="Previous month">&laquo; Prev</button>
                    <h2>{displayDate.toLocaleString('default', { month: 'long', year: 'numeric' })}</h2>
                    <button onClick={() => changeMonth(1)} aria-label="Next month">Next &raquo;</button>
                </div>

                <div className="calendar-grid" role="grid" aria-label="Test history calendar">
                    {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
                        <div key={day} className="calendar-header-cell" role="columnheader">{day.substring(0,1)}</div>
                    ))}
                    {calendarDays.map((date, index) => {
                        const localDateKeyForCell = date ? getLocalDateKey(date) : null;
                        const testsOnThisDay = localDateKeyForCell ? testsByDate[localDateKeyForCell] || [] : [];
                        const hasTests = testsOnThisDay.length > 0;
                        const isSelected = localDateKeyForCell === selectedDateKey;
                        
                        const todayKey = getLocalDateKey(new Date());
                        const isToday = date && localDateKeyForCell === todayKey;

                        let dayLabel = date ? `${date.toLocaleDateString('default', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}` : 'Empty day';
                        if (hasTests) {
                            dayLabel += `. ${testsOnThisDay.length} test${testsOnThisDay.length > 1 ? 's' : ''} taken.`;
                        } else if (date) {
                            dayLabel += '. No tests on this day.';
                        }

                        return (
                            <button
                                key={date ? date.toISOString() : `empty-${index}`} 
                                className={`calendar-day ${date ? '' : 'calendar-day-empty'} ${isSelected ? 'calendar-day-selected' : ''} ${isToday && !isSelected ? 'calendar-day-today' : ''}`}
                                onClick={() => handleDayClick(date)}
                                disabled={!date}
                                role="gridcell"
                                aria-selected={isSelected}
                                aria-label={dayLabel}
                                title={hasTests ? `${testsOnThisDay.length} test${testsOnThisDay.length > 1 ? 's' : ''} on this day` : (date ? 'No tests on this day' : '')}
                            >
                                <span className="day-number">{date ? date.getDate() : ''}</span>
                                {hasTests && <span className="test-indicator" aria-hidden="true"></span>}
                            </button>
                        );
                    })}
                </div>
            </div>

            {selectedDateKey && (
                <div className="selected-test-details-container">
                    <h3>
                        Tests on {getFormattedSelectedDateHeader()}
                    </h3>
                    {selectedTests.length > 0 ? selectedTests.map(test => (
                        <div key={test.id} className="selected-test-item">
                            <h4>Test taken at: {new Date(test.dateISO).toLocaleTimeString()} ({test.numberOfPassages} passage{test.numberOfPassages > 1 ? 's' : ''})</h4>
                            <p>Passage Snippet: <em>{test.passageSummary}</em></p>
                            <p>Score: <strong>{test.score} / {test.totalPossibleScore}</strong></p>
                            <p>Time Spent: {formatTime(test.timeTakenSec)}</p>
                            <p>Correct: {test.correctCount}, Incorrect: {test.incorrectCount}, Unattempted: {test.unattemptedCount}</p>
                            <button onClick={() => onSelectTestForDetails(test)} className="view-details-button button-small">View Details</button>
                        </div>
                    )) : (
                         <p>No tests recorded for this day.</p>
                    )}
                </div>
            )}
        </div>
    );
};

interface ArchivedTestDetailViewProps {
    testData: StoredTestResult;
    onBack: () => void;
    onReattempt: (testData: StoredTestResult) => void;
}

const ArchivedTestDetailView: React.FC<ArchivedTestDetailViewProps> = ({ testData, onBack, onReattempt }) => {
    return (
        <div className="archived-test-detail-container">
            <header className="header">
                <h1>Test Review</h1>
                <p className="test-taken-date">Reviewing test ({testData.numberOfPassages} passage{testData.numberOfPassages > 1 ? 's' : ''}) taken on: {new Date(testData.dateISO).toLocaleString()}</p>
            </header>
            <div className="archived-test-actions-bar">
                <button onClick={onBack} className="back-button" aria-label="Return to the calendar view">Back to Calendar</button>
                <button onClick={() => onReattempt(testData)} className="reattempt-button" aria-label="Reattempt this test with a fresh timer">Reattempt This Test</button>
            </div>

            <PerformanceAnalysisCard userScore={testData.score} totalPossibleScore={testData.totalPossibleScore} />

            <div className="passage-display-test archived-passage">
                <h3>Original Reading Passage(s)</h3>
                <div dangerouslySetInnerHTML={{ __html: testData.fullPassage.replace(/\n/g, '<br />') }} />
            </div>

            <h3 className="detailed-review-heading">Detailed Answer Review (from original attempt):</h3>
            {testData.questions.map((q, index) => {
                const qState = testData.questionStates[index]; 
                const userAnswer = qState.selectedOption;
                const isCorrect = userAnswer === q.correctAnswerText;
                const isAttempted = userAnswer && userAnswer !== '';

                return (
                    <div key={q.id} className="result-question-item detailed archived-item">
                        <h4>Question {index + 1}: {q.questionText}</h4>
                        <ul className="result-options-list">
                            {q.options.map((option, optIndex) => (
                                <li
                                    key={optIndex}
                                    className={`
                                        ${option === q.correctAnswerText ? 'correct-answer-highlight' : ''}
                                        ${option === userAnswer ? (isCorrect ? 'user-selected user-correct' : 'user-selected user-incorrect') : ''}
                                    `}
                                    aria-label={`Option: ${option}${option === q.correctAnswerText ? '. Correct answer.' : ''}${option === userAnswer ? (isCorrect ? ' You selected this. Correct.' : ' You selected this. Incorrect.') : ''}`}
                                >
                                    {option}
                                    {option === q.correctAnswerText && userAnswer === option && <span className="status-icon correct"> ✔ Your Answer (Correct)</span>}
                                    {option !== q.correctAnswerText && userAnswer === option && <span className="status-icon incorrect"> ✘ Your Answer (Incorrect)</span>}
                                    {option === q.correctAnswerText && (!userAnswer || userAnswer !== option) && <span className="status-icon correct-only"> ✔ Correct Answer</span>}
                                </li>
                            ))}
                        </ul>
                        {!isAttempted && <p className="not-attempted-feedback"><em>Not Attempted in this test. Correct answer was: {q.correctAnswerText}</em></p>}
                        
                        <div className="result-analysis-section">
                            <p><strong>Your Answer (this attempt):</strong> {userAnswer || "Not Attempted"}</p>
                            <p><strong>Correct Answer:</strong> {q.correctAnswerText}</p>
                            <p><strong>Time Spent (this question, this attempt):</strong> {formatTime(qState.timeSpentOnQuestion)}</p>
                            <div className="explanation-box">
                                <strong>Explanation:</strong>
                                <p>{q.explanation}</p>
                            </div>
                             <div className="ai-insights-box">
                                <strong>AI Insights:</strong>
                                <p><em>Difficulty:</em> {q.difficultyAssessment}</p>
                                <p><em>Common Pitfalls:</em> {q.commonPitfalls}</p>
                            </div>
                        </div>
                    </div>
                );
            })}
             <div className="archived-test-actions-bar bottom-bar">
                <button onClick={onBack} className="back-button" aria-label="Return to the calendar view">Back to Calendar</button>
                <button onClick={() => onReattempt(testData)} className="reattempt-button" aria-label="Reattempt this test with a fresh timer">Reattempt This Test</button>
            </div>
        </div>
    );
};


const generateOfflineTestHTML = (passage: string, questionsArray: Question[], totalTime: number): string => {
    const cssStyles = `
    body{font-family:'Roboto',sans-serif;margin:0;padding:0;background-color:#f0f2f5;color:#333;display:flex;justify-content:center;align-items:flex-start;min-height:100vh;padding-top:20px;box-sizing:border-box}
    #root-html-test{width:100%;max-width:1200px;background-color:#fff;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.1);padding:20px 30px;box-sizing:border-box}
    .header-html{text-align:center;padding-bottom:15px;border-bottom:1px solid #e0e0e0}.header-html h1{font-family:'Lato',sans-serif;color:#1a237e;margin:0;font-size:2.2em}
    button{background-color:#3f51b5;color:#fff;border:none;padding:10px 18px;text-align:center;text-decoration:none;display:inline-block;font-size:.95rem;font-weight:500;border-radius:4px;cursor:pointer;transition:background-color .3s ease,box-shadow .2s ease;min-width:120px;box-shadow:0 2px 4px rgba(0,0,0,.1)}
    button:hover{background-color:#303f9f;box-shadow:0 4px 8px rgba(0,0,0,.15)}button:disabled{background-color:#9fa8da;cursor:not-allowed;box-shadow:none}
    .test-environment-html{display:flex;gap:20px;border:1px solid #ddd;border-radius:8px;padding:20px;background-color:#f8f9fa; margin-top: 20px;}
    .question-navigation-panel-html{width:220px;flex-shrink:0;padding:15px;background-color:#e8eaf6;border-radius:6px;display:flex;flex-direction:column;gap:15px;height:fit-content;box-shadow:0 2px 5px rgba(0,0,0,.05)}
    .question-navigation-panel-html h3{margin:0 0 10px;text-align:center;color:#1a237e;font-size:1.3em}
    .timer-display-html{font-size:1.3rem;font-weight:700;color:#c62828;text-align:center;padding:8px;background-color:#ffebee;border:1px solid #ffcdd2;border-radius:4px;margin-bottom:10px}
    .question-status-list-html{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(45px,1fr));gap:8px}
    .question-status-item-html{padding:10px 5px;text-align:center;border:1px solid #9fa8da;border-radius:4px;cursor:pointer;font-weight:500;transition:background-color .2s,color .2s,transform .1s;background-color:#fff}
    .question-status-item-html:hover{background-color:#c5cae9}
    .question-status-item-html.active{background-color:#3f51b5;color:#fff;border-color:#303f9f;font-weight:700;transform:scale(1.05)}
    .question-status-item-html.answered{background-color:#e8f5e9;border-color:#a5d6a7}
    .question-status-item-html.answered.active{background-color:#2e7d32;color:#fff;border-color:#1b5e20}
    .question-status-item-html.review{border-left:5px solid #ffab00;}
    .submit-test-button-main-html{width:100%;background-color:#d32f2f;margin-top:auto}
    .submit-test-button-main-html:hover{background-color:#c62828}
    .test-main-area-html{flex-grow:1;display:flex;flex-direction:column;gap:20px}
    .passage-display-test-html{background-color:#fff;padding:15px;border-radius:6px;border:1px solid #e0e0e0;max-height:300px;overflow-y:auto;line-height:1.6}
    .passage-display-test-html h3{margin-top:0;margin-bottom:10px;color:#3f51b5}
    .question-display-area-html{background-color:#fff;padding:20px;border-radius:6px;border:1px solid #e0e0e0;box-shadow:0 1px 3px rgba(0,0,0,.05)}
    .question-display-area-html h3{margin-top:0;margin-bottom:15px;color:#1a237e}
    .question-text-bold-html{font-weight:500;line-height:1.5;margin-bottom:15px;font-size:1.1em}
    .options-fieldset-html{border:none;padding:0;margin:0 0 20px}
    .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border-width:0}
    .options-list-html{list-style:none;padding:0;margin:0}
    .options-list-html li{margin-bottom:10px}
    .options-list-html label{display:flex;align-items:center;cursor:pointer;padding:12px;border-radius:4px;transition:background-color .2s,border-color .2s;border:1px solid #ddd;line-height:1.5}
    .options-list-html label:hover{background-color:#f0f4ff;border-color:#b0bec5}
    .options-list-html input[type=radio]{margin-right:12px;accent-color:#3f51b5;flex-shrink:0;transform:scale(1.1)}
    .question-actions-html{display:flex;gap:10px;margin-bottom:20px;border-top:1px solid #eee;padding-top:15px}
    .question-actions-html button.marked-for-review-active{background-color:#ffab00;color:#000}
    .question-actions-html button.marked-for-review-active:hover{background-color:#ff8f00}
    .question-navigation-buttons-html{display:flex;justify-content:space-between;border-top:1px solid #eee;padding-top:15px}
    .results-container-html{padding:20px;border:1px solid #ddd;border-radius:8px;background-color:#f9f9f9; margin-top: 20px;}
    .results-summary-html{text-align:center;margin-bottom:30px;padding:20px;background-color:#e8eaf6;border-radius:6px}
    .results-summary-html h2{font-size:2rem;color:#2e7d32;margin-bottom:10px}
    .results-summary-html p{font-size:1.5rem;font-weight:700;color:#1a237e}
    .overall-analysis-html{display:flex;justify-content:space-around;flex-wrap:wrap;gap:15px;margin-top:20px;font-size:1rem}
    .overall-analysis-html p{background-color:#fff;padding:8px 12px;border-radius:4px;font-size:1rem;font-weight:500;color:#333;box-shadow:0 1px 2px rgba(0,0,0,.1)}
    .results-container-html h3{margin-bottom:20px;font-size:1.5em;color:#3f51b5;border-bottom:2px solid #3f51b5;padding-bottom:5px}
    .result-question-item-html{margin-bottom:25px;padding:20px;border:1px solid #ccc;border-radius:8px;background-color:#fff;box-shadow:0 2px 5px rgba(0,0,0,.05)}
    .result-question-item-html h4{margin-top:0;margin-bottom:15px;font-size:1.2em;line-height:1.5;color:#1a237e}
    .result-options-list-html{list-style:none;padding:0;margin-bottom:15px}
    .result-options-list-html li{padding:10px 12px;margin-bottom:8px;border-radius:4px;border:1px solid #e0e0e0;line-height:1.5;position:relative}
    .result-options-list-html li.correct-answer-highlight{background-color:#e8f5e9;border-color:#a5d6a7;font-weight:700}
    .result-options-list-html li.user-selected.user-correct{border-left:5px solid #2e7d32}
    .result-options-list-html li.user-selected.user-incorrect{background-color:#ffebee;border-color:#ef9a9a;text-decoration:line-through;border-left:5px solid #c62828}
    .status-icon-html{margin-left:10px;font-weight:700;font-size:.9em}
    .status-icon-html.correct,.status-icon-html.correct-only{color:#2e7d32}
    .status-icon-html.incorrect{color:#c62828}
    .not-attempted-feedback-html{font-style:italic;color:#555;margin-top:10px;padding:10px;background-color:#fffde7;border-left:3px solid #fbc02d;border-radius:4px}
    .result-analysis-section-html{margin-top:15px;padding-top:15px;border-top:1px dashed #ccc}
    .result-analysis-section-html p{margin-bottom:8px;font-size:.95em}
    .result-analysis-section-html p strong{color:#3f51b5}
    .explanation-box-html,.ai-insights-box-html{margin-top:15px;padding:15px;border-radius:4px;line-height:1.6}
    .explanation-box-html{background-color:#e3f2fd;border:1px solid #bbdefb}
    .explanation-box-html strong{display:block;margin-bottom:5px;color:#0d47a1}
    .ai-insights-box-html{background-color:#f3e5f5;border:1px solid #e1bee7}
    .ai-insights-box-html strong{display:block;margin-bottom:5px;color:#4a148c}
    .ai-insights-box-html p em{font-weight:500;color:#6a1b9a}
    .start-new-test-button-html{display:block;margin:30px auto 0 auto;padding:12px 25px;font-size:1.1rem;background-color:#28a745}
    .start-new-test-button-html:hover{background-color:#218838}
    .spinner{width:40px;height:40px;border:4px solid #f3f3f3;border-top:4px solid #3498db;border-radius:50%;animation:spin 1s linear infinite;margin:20px auto}
    @keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
    `;

    const offlineTestScript = `
        const passageData = ${JSON.stringify(passage)};
        const questionsData = ${JSON.stringify(questionsArray)};
        const TOTAL_TIME_SECONDS_HTML = ${totalTime};

        let currentQuestionIndex = 0;
        let timeLeft = TOTAL_TIME_SECONDS_HTML;
        let timerIntervalId = null;
        let questionTimerStartRef = 0;
        let questionStates = questionsData.map(q => ({
            questionId: q.id,
            selectedOption: '',
            isMarkedForReview: false,
            timeSpentOnQuestion: 0
        }));
        let score = 0;
        let appState = 'TAKING_TEST'; 

        const $ = (selector) => document.querySelector(selector);
        const $$ = (selector) => document.querySelectorAll(selector);

        const formatTimeOffline = (totalSeconds) => { 
            const minutes = Math.floor(totalSeconds / 60);
            const seconds = totalSeconds % 60;
            return \`\${String(minutes).padStart(2, '0')}:\${String(seconds).padStart(2, '0')}\`;
        };
        
        const recordTimeSpent = () => {
            if (questionStates[currentQuestionIndex] && questionTimerStartRef > 0) {
                const timeSpent = Math.floor((Date.now() - questionTimerStartRef) / 1000);
                questionStates[currentQuestionIndex].timeSpentOnQuestion += timeSpent;
            }
            questionTimerStartRef = Date.now();
        };

        const renderQuestionNavigation = () => {
            const navList = $('.question-status-list-html');
            navList.innerHTML = ''; 
            questionsData.forEach((q, index) => {
                const li = document.createElement('li');
                li.className = \`question-status-item-html 
                                \${index === currentQuestionIndex ? 'active' : ''}
                                \${questionStates[index]?.selectedOption ? 'answered' : 'unanswered'}
                                \${questionStates[index]?.isMarkedForReview ? 'review' : ''}\`;
                li.textContent = \`Q\${index + 1}\`;
                li.setAttribute('role', 'button');
                li.setAttribute('tabindex', '0');
                li.setAttribute('aria-label', \`Go to question \${index + 1}\`);
                li.onclick = () => navigateQuestion('jump', index);
                li.onkeydown = (e) => e.key === 'Enter' && navigateQuestion('jump', index);
                navList.appendChild(li);
            });
        };

        const renderQuestion = () => {
            if (!questionsData[currentQuestionIndex]) return;
            const q = questionsData[currentQuestionIndex];
            const qState = questionStates[currentQuestionIndex];

            let passageDisplayContent = passageData;
            passageDisplayContent = passageDisplayContent.replace(/\\n/g, '<br />').replace(/---\\n\\n---/g, '<hr style="margin: 20px 0; border-top: 1px dashed #ccc;">');
            passageDisplayContent = passageDisplayContent.replace(/\\[START OF PASSAGE (\\d+)\\]<br \\/>/g, (match, pNum) => \`<hr style="margin: 20px 0; border-top: 2px solid #1a237e; border-bottom: none;"><h4 style="color:#1a237e; text-align:center;">START OF PASSAGE \${pNum}</h4>\`)
                                       .replace(/<br \\/>\\[END OF PASSAGE (\\d+)\\]/g, '');


            $('.passage-display-test-html div').innerHTML = passageDisplayContent;
            $('.question-display-area-html h3').textContent = \`Question \${currentQuestionIndex + 1} of \${questionsData.length}\`;
            $('.question-text-bold-html').textContent = q.questionText;
            
            const optionsList = $('.options-list-html');
            optionsList.innerHTML = '';
            q.options.forEach((option, optIndex) => {
                const li = document.createElement('li');
                const label = document.createElement('label');
                const input = document.createElement('input');
                input.type = 'radio';
                input.name = q.id;
                input.value = option;
                input.checked = qState.selectedOption === option;
                input.onchange = () => handleAnswerSelection(option);
                
                const span = document.createElement('span');
                span.textContent = option;
                
                label.appendChild(input);
                label.appendChild(span);
                li.appendChild(label);
                optionsList.appendChild(li);
            });

            $('#save-answer-btn-html').disabled = !qState.selectedOption;
             $('#save-answer-btn-html').textContent = qState.selectedOption ? "Answer Recorded" : "Select an Answer";
            const markReviewBtn = $('#mark-review-btn-html');
            markReviewBtn.textContent = qState.isMarkedForReview ? 'Unmark Review' : 'Mark for Review';
            markReviewBtn.className = qState.isMarkedForReview ? 'marked-for-review-active' : '';

            $('#prev-btn-html').disabled = currentQuestionIndex === 0;
            $('#next-btn-html').disabled = currentQuestionIndex === questionsData.length - 1;
            renderQuestionNavigation();
        };

        const handleAnswerSelection = (option) => {
            questionStates[currentQuestionIndex].selectedOption = option;
            $('#save-answer-btn-html').disabled = false;
            $('#save-answer-btn-html').textContent = "Answer Recorded";
            renderQuestionNavigation(); 
        };

        const handleSaveAnswer = () => {
            alert('Answer recorded! Your selection is saved as you click it.'); 
        };
        
        const handleMarkForReview = () => {
            questionStates[currentQuestionIndex].isMarkedForReview = !questionStates[currentQuestionIndex].isMarkedForReview;
            renderQuestion(); 
        };

        const navigateQuestion = (direction, index) => {
            recordTimeSpent();
            if (direction === 'next' && currentQuestionIndex < questionsData.length - 1) {
                currentQuestionIndex++;
            } else if (direction === 'prev' && currentQuestionIndex > 0) {
                currentQuestionIndex--;
            } else if (direction === 'jump' && index !== undefined && index >= 0 && index < questionsData.length) {
                currentQuestionIndex = index;
            }
            renderQuestion();
        };

        const submitTest = () => {
            recordTimeSpent();
            if (timerIntervalId) clearInterval(timerIntervalId);
            timerIntervalId = null;
            appState = 'VIEWING_RESULTS';

            let currentScore = 0;
            questionsData.forEach((q, i) => {
                const state = questionStates[i];
                if (state.selectedOption) {
                    if (state.selectedOption === q.correctAnswerText) currentScore += 3;
                    else currentScore -= 1;
                }
            });
            score = currentScore;
            renderResults();
        };
        
        const renderResults = () => {
            $('.test-environment-html').style.display = 'none';
            const resultsContainer = $('.results-container-html');
            resultsContainer.style.display = 'block';
            
            $('#final-score-html').textContent = \`\${score} / \${questionsData.length * 3}\`;
            $('#total-questions-html').textContent = questionsData.length;
            $('#correct-answers-html').textContent = questionStates.filter((qs, i) => qs.selectedOption && qs.selectedOption === questionsData[i].correctAnswerText).length;
            $('#incorrect-answers-html').textContent = questionStates.filter((qs, i) => qs.selectedOption && qs.selectedOption !== questionsData[i].correctAnswerText).length;
            $('#unattempted-html').textContent = questionStates.filter(qs => !qs.selectedOption).length;
            $('#total-time-spent-html').textContent = formatTimeOffline(TOTAL_TIME_SECONDS_HTML - timeLeft);

            const detailedReviewContainer = $('#detailed-review-container-html');
            detailedReviewContainer.innerHTML = '';

            questionsData.forEach((q, index) => {
                const qState = questionStates[index];
                const userAnswer = qState.selectedOption;
                const isCorrect = userAnswer === q.correctAnswerText;
                const isAttempted = userAnswer && userAnswer !== '';

                const itemDiv = document.createElement('div');
                itemDiv.className = 'result-question-item-html detailed';
                itemDiv.innerHTML = \`
                    <h4>Question \${index + 1}: \${q.questionText}</h4>
                    <ul class="result-options-list-html">
                        \${q.options.map(opt => \`
                            <li class="\${opt === q.correctAnswerText ? 'correct-answer-highlight' : ''} \${opt === userAnswer ? (isCorrect ? 'user-selected user-correct' : 'user-selected user-incorrect') : ''}">
                                \${opt}
                                \${opt === q.correctAnswerText && userAnswer === opt ? '<span class="status-icon-html correct"> ✔ Your Answer (Correct)</span>' : ''}
                                \${opt !== q.correctAnswerText && userAnswer === opt ? '<span class="status-icon-html incorrect"> ✘ Your Answer (Incorrect)</span>' : ''}
                                \${opt === q.correctAnswerText && (!userAnswer || userAnswer !== opt) ? '<span class="status-icon-html correct-only"> ✔ Correct Answer</span>' : ''}
                            </li>
                        \`).join('')}
                    </ul>
                    \${!isAttempted ? \`<p class="not-attempted-feedback-html"><em>Not Attempted. Correct answer was: \${q.correctAnswerText}</em></p>\` : ''}
                    <div class="result-analysis-section-html">
                        <p><strong>Your Answer:</strong> \${userAnswer || "Not Attempted"}</p>
                        <p><strong>Correct Answer:</strong> \${q.correctAnswerText}</p>
                        <p><strong>Time Spent:</strong> \${formatTimeOffline(qState.timeSpentOnQuestion)}</p>
                        <div class="explanation-box-html">
                            <strong>Explanation:</strong><p>\${q.explanation}</p>
                        </div>
                        <div class="ai-insights-box-html">
                            <strong>AI Insights:</strong>
                            <p><em>Difficulty:</em> \${q.difficultyAssessment}</p>
                            <p><em>Common Pitfalls:</em> \${q.commonPitfalls}</p>
                        </div>
                    </div>
                \`;
                detailedReviewContainer.appendChild(itemDiv);
            });
        };

        const startTimer = () => {
            questionTimerStartRef = Date.now();
            $('.timer-display-html').textContent = \`Time Left: \${formatTimeOffline(timeLeft)}\`;
            timerIntervalId = setInterval(() => {
                timeLeft--;
                $('.timer-display-html').textContent = \`Time Left: \${formatTimeOffline(timeLeft)}\`;
                if (timeLeft <= 0) {
                    clearInterval(timerIntervalId);
                    submitTest();
                }
            }, 1000);
        };

        document.addEventListener('DOMContentLoaded', () => {
            $('.timer-display-html').textContent = \`Time Left: \${formatTimeOffline(TOTAL_TIME_SECONDS_HTML)}\`;
            renderQuestion();
            startTimer();

            $('#prev-btn-html').onclick = () => navigateQuestion('prev');
            $('#next-btn-html').onclick = () => navigateQuestion('next');
            $('#save-answer-btn-html').onclick = handleSaveAnswer;
            $('#mark-review-btn-html').onclick = handleMarkForReview;
            $('.submit-test-button-main-html').onclick = submitTest;
            $('#start-new-test-offline-btn').onclick = () => {
                alert("To start a new test, please re-open this HTML file or generate a new one from the online app.");
            };
        });
    `;
    
    let htmlPassageDisplay = passage.replace(/\n/g, '<br />');
    htmlPassageDisplay = htmlPassageDisplay.replace(/\[START OF PASSAGE (\d+)\]<br \/>/g, (match, pNum) => `<hr style="margin: 20px 0; border-top: 2px solid #1a237e; border-bottom: none;"><h4 style="color:#1a237e; text-align:center;">START OF PASSAGE ${pNum}</h4>`)
                                       .replace(/<br \/>\[END OF PASSAGE (\d+)\]/g, '');


    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>CAT RC Practice Test (Offline)</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&family=Lato:wght@400;700&display=swap" rel="stylesheet">
        <style>${cssStyles}</style>
    </head>
    <body>
        <div id="root-html-test">
            <header class="header-html"><h1>CAT RC Practice Test (Offline)</h1></header>

            <div class="test-environment-html">
                <div class="test-main-area-html">
                    <div class="passage-display-test-html">
                        <h3>Reading Passage(s)</h3>
                        <div>${htmlPassageDisplay}</div>
                    </div>
                    <div class="question-display-area-html">
                        <h3>Question 1 of ${questionsArray.length}</h3>
                        <p class="question-text-bold-html"></p>
                        <fieldset class="options-fieldset-html" role="radiogroup">
                            <legend class="sr-only">Question options</legend>
                            <ul class="options-list-html"></ul>
                        </fieldset>
                        <div class="question-actions-html">
                            <button id="save-answer-btn-html">Save Answer</button>
                            <button id="mark-review-btn-html">Mark for Review</button>
                        </div>
                        <div class="question-navigation-buttons-html">
                            <button id="prev-btn-html">Previous</button>
                            <button id="next-btn-html">Next</button>
                        </div>
                    </div>
                </div>
                <div class="question-navigation-panel-html">
                    <h3>Questions</h3>
                    <div class="timer-display-html" role="timer" aria-live="polite">${formatTime(totalTime)}</div>
                    <ul class="question-status-list-html"></ul>
                    <button class="submit-test-button-main-html">Submit Test</button>
                </div>
            </div>

            <div class="results-container-html" style="display:none;">
                <div class="results-summary-html">
                    <h2>Test Results</h2>
                    <p>Your Final Score: <span id="final-score-html">0</span></p>
                    <div class="overall-analysis-html">
                        <p>Total Questions: <span id="total-questions-html">0</span></p>
                        <p>Correct: <span id="correct-answers-html">0</span></p>
                        <p>Incorrect: <span id="incorrect-answers-html">0</span></p>
                        <p>Unattempted: <span id="unattempted-html">0</span></p>
                        <p>Total Time Spent: <span id="total-time-spent-html">00:00</span></p>
                    </div>
                </div>
                <h3>Detailed Answer Review:</h3>
                <div id="detailed-review-container-html"></div>
                <button id="start-new-test-offline-btn" class="start-new-test-button-html">Start New Test (Info)</button>
            </div>
        </div>
        <script>${offlineTestScript.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$')}<\/script> 
    </body>
    </html>`;
};


const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  );
} else {
  console.error("Root element not found");
};
