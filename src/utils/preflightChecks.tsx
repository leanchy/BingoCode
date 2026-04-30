//@C:ID=M.PC.preflightCheck;K=M;V=1.0;P=Import dependencies;D=UI;M=Connectivity;S=PreflightChecks
import { c as _c } from "react/compiler-runtime";
import axios from 'axios';
import React, { useEffect, useState } from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { Spinner } from '../components/Spinner.js';
import { getOauthConfig } from '../constants/oauth.js';
import { useTimeout } from '../hooks/useTimeout.js';
import { Box, Text } from '../ink.js';
import { getSSLErrorHint } from '../services/api/errorUtils.js';
import { getUserAgent } from './http.js';
import { logError } from './log.js';

//@C:ID=T.PC.PreflightCheckResult;K=T;V=1.0;P=Define check result interface;D=UI;M=Connectivity;S=Types
export interface PreflightCheckResult {
  success: boolean;
  error?: string;
  sslHint?: string;
}

//@C:ID=T.PC.PreflightStepProps;K=T;V=1.0;P=Define component props interface;D=UI;M=Connectivity;S=Types
interface PreflightStepProps {
  onSuccess: () => void;
}

//@C:ID=F.PC.checkEndpoints;K=F;V=1.0;P=Check API endpoint connectivity;D=UI;M=Connectivity;S=NetworkChecks;In=void;Out=Promise<PreflightCheckResult>
async function checkEndpoints(): Promise<PreflightCheckResult> {
  console.log("F.PC.checkEndpoints");
  
  try {
    ///@C:PC.PrepareEndpoints
    const oauthConfig = getOauthConfig();
    const tokenUrl = new URL(oauthConfig.TOKEN_URL);
    const endpoints = [
      `${oauthConfig.BASE_API_URL}/api/hello`, 
      `${tokenUrl.origin}/v1/oauth/hello`
    ];
    
    ///@C:PC.DefineCheckFunction
    const checkEndpoint = async (url: string): Promise<PreflightCheckResult> => {
      try {
        const response = await axios.get(url, {
          headers: {
            'User-Agent': getUserAgent()
          }
        });
        if (response.status !== 200) {
          const hostname = new URL(url).hostname;
          return {
            success: false,
            error: `Failed to connect to ${hostname}: Status ${response.status}`
          };
        }
        return {
          success: true
        };
      } catch (error) {
        const hostname = new URL(url).hostname;
        const sslHint = getSSLErrorHint(error);
        return {
          success: false,
          error: `Failed to connect to ${hostname}: ${error instanceof Error ? (error as ErrnoException).code || error.message : String(error)}`,
          sslHint: sslHint ?? undefined
        };
      }
    };
    
    ///@C:PC.ProcessResults
    const results = await Promise.all(endpoints.map(checkEndpoint));
    const failedResult = results.find(result => !result.success);
    
    if (failedResult) {
      // Log failure to Statsig
      logEvent('tengu_preflight_check_failed', {
        isConnectivityError: false,
        hasErrorMessage: !!failedResult.error,
        isSSLError: !!failedResult.sslHint
      });
    }
    
    return failedResult || {
      success: true
    };
  } catch (error) {
    logError(error as Error);

    // Log to Statsig
    logEvent('tengu_preflight_check_failed', {
      isConnectivityError: true
    });
    
    return {
      success: false,
      error: `Connectivity check error: ${error instanceof Error ? (error as ErrnoException).code || error.message : String(error)}`
    };
  }
}

//@C:ID=U.PC.PreflightStep;K=U;V=1.0;P=Connectivity check UI component;D=UI;M=Connectivity;S=PreflightChecks
export function PreflightStep(t0) {
  console.log("U.PC.PreflightStep");
  
  ///@C:PC.ComponentSetup
  const $ = _c(12);
  const {
    onSuccess
  } = t0;
  const [result, setResult] = useState(null);
  const [isChecking, setIsChecking] = useState(true);
  const showSpinner = useTimeout(1000) && isChecking;
  
  ///@C:PC.RunCheckEffect
  let t1;
  let t2;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = () => {
      const run = async function run() {
        const checkResult = await checkEndpoints();
        setResult(checkResult);
        setIsChecking(false);
      };
      run();
    };
    t2 = [];
    $[0] = t1;
    $[1] = t2;
  } else {
    t1 = $[0];
    t2 = $[1];
  }
  useEffect(t1, t2);
  
  ///@C:PC.HandleResultEffect
  let t3;
  let t4;
  if ($[2] !== onSuccess || $[3] !== result) {
    t3 = () => {
      if (result?.success) {
        onSuccess();
      } else {
        if (result && !result.success) {
          const timer = setTimeout(_temp, 100);
          return () => clearTimeout(timer);
        }
      }
    };
    t4 = [result, onSuccess];
    $[2] = onSuccess;
    $[3] = result;
    $[4] = t3;
    $[5] = t4;
  } else {
    t3 = $[4];
    t4 = $[5];
  }
  useEffect(t3, t4);
  
  ///@C:PC.RenderUI
  let t5;
  if ($[6] !== isChecking || $[7] !== result || $[8] !== showSpinner) {
    t5 = isChecking && showSpinner ? 
      <Box paddingLeft={1}>
        <Spinner />
        <Text>Checking connectivity...</Text>
      </Box> : 
      !result?.success && !isChecking && 
      <Box flexDirection="column" gap={1}>
        <Text color="error">Unable to connect to Anthropic services</Text>
        <Text color="error">{result?.error}</Text>
        {result?.sslHint ? 
          <Box flexDirection="column" gap={1}>
            <Text>{result.sslHint}</Text>
            <Text color="suggestion">See https://code.claude.com/docs/en/network-config</Text>
          </Box> : 
          <Box flexDirection="column" gap={1}>
            <Text>Please check your internet connection and network settings.</Text>
            <Text>Note: Claude Code might not be available in your country. Check supported countries at{" "}
              <Text color="suggestion">https://anthropic.com/supported-countries</Text>
            </Text>
          </Box>
        }
      </Box>;
    $[6] = isChecking;
    $[7] = result;
    $[8] = showSpinner;
    $[9] = t5;
  } else {
    t5 = $[9];
  }
  
  let t6;
  if ($[10] !== t5) {
    t6 = <Box flexDirection="column" gap={1} paddingLeft={1}>{t5}</Box>;
    $[10] = t5;
    $[11] = t6;
  } else {
    t6 = $[11];
  }
  
  return t6;
}

//@C:ID=F.PC._temp;K=F;V=1.0;P=Helper function for process exit;D=UI;M=Connectivity;S=Utility;In=void;Out=void
function _temp() {
  console.log("F.PC._temp");
  
  return process.exit(1);
}