declare module 'javascript-lp-solver' {
  export interface LPConstraint {
    equal?: number;
    min?: number;
    max?: number;
    [key: string]: number | undefined;
  }

  export interface LPVariable {
    [constraintName: string]: number;
  }

  export interface LPModel {
    optimize: string;
    opType: 'min' | 'max';
    constraints: {
      [name: string]: LPConstraint;
    };
    variables: {
      [name: string]: LPVariable;
    };
    ints?: {
      [name: string]: 1;
    };
    binaries?: {
      [name: string]: 1;
    };
    options?: {
      timeout?: number;
      tolerance?: number;
    };
  }

  export interface LPSolution {
    feasible: boolean;
    result: number;
    bounded?: boolean;
    isCurrentContext?: boolean;
    [variableName: string]: number | boolean | undefined;
  }

  export function Solve(model: LPModel): LPSolution;
  
  const solver: {
    Solve: (model: LPModel) => LPSolution;
    Model: any;
  };

  export default solver;
}
