const dao = require('../src/dao');

// Mocking global dependencies
global.config = {
    fundRequestBaseFee: 100,
    fundRequestSubStart: 500,
    fundRequestSubFee: 0.1,
    fundRequestSubMult: 10,
    daoVotingThreshold: 50,
    daoLeaderSnapshotBlocks: 10,
    daoMembers: {},
    chainUpdateGracePeriodSeconds: 60,
    fundRequestStatus: {
        votingActive: 0,
        votingRejected: 1,
        fundingActive: 2,
        fundingFailed: 3,
        proposalExpired: 4,
        fundingSuccess: 5,
        revisionRequired: 6,
        reviewInProgress: 7,
        proposalComplete: 8
    },
    chainUpdateStatus: {
        votingActive: 0,
        votingRejected: 1,
        votingSuccess: 2,
        executed: 3
    },
    proposalState: {
        failed: 'failed',
        success: 'success'
    },
    governanceTypes: {
        fundRequest: 1,
        chainUpdate: 2
    }
};

global.logr = {
    warn: console.warn,
    trace: console.log
};

global.cache = {
    findOnePromise: async (coll, query) => {
        if (query.name === 'creator') return { name: 'creator', balance: 1000 };
        if (query.name === 'beneficiary') return { name: 'beneficiary', balance: 1000 };
        return { name: 'generic', balance: 1000 };
    },
    updateOnePromise: async (coll, query, update, options) => {
        console.log(`Mocking update on ${coll} for ${JSON.stringify(query)}`);
        return true;
    }
};

global.transaction = {
    updateIntsAndNodeApprPromise: async (account, ts, amount) => {
        console.log(`Mocking transaction update for ${account.name}`);
        return true;
    }
};

global.db = {
    collection: () => ({
        insertOne: async () => true,
        find: () => ({
            toArray: async () => []
        })
    })
};

global.chain = {
    recentBlocks: [],
    getLatestBlock: () => ({ _id: 100 })
};

// Test Suite
async function runTests() {
    console.log('Starting DAO Unit Tests...');

    // Test 1: fundRequestCreationFee Sanity Check (Negative/Zero)
    console.log('Test 1: fundRequestCreationFee with <= 0');
    let feeLow = dao.fundRequestCreationFee(0);
    if (feeLow === global.config.fundRequestBaseFee) {
        console.log('✅ Passed: Returned base fee for 0 input');
    } else {
        console.error('❌ Failed: Expected base fee for 0 input');
    }

    // Test 2: fundRequestCreationFee Normal Calculation
    console.log('Test 2: fundRequestCreationFee with valid amount');
    let feeNormal = dao.fundRequestCreationFee(1000);
    if (feeNormal > global.config.fundRequestBaseFee) {
        console.log('✅ Passed: Calculated higher fee for large request');
    } else {
        console.error('❌ Failed: Did not calculate subseq fee correctly');
    }

    // Test 3: refundContributors Sanity Check (Negative amount)
    console.log('Test 3: refundContributors with negative amount in list');
    const proposalWithNeg = {
        contrib: { 'user1': -50, 'user2': 100 },
        creator: 'creator'
    };
    // This should not throw and should skip the negative one
    try {
        await dao.refundContributors(proposalWithNeg, Date.now());
        console.log('✅ Passed: Handled negative amount in contributors list');
    } catch (e) {
        console.error('❌ Failed: Threw error on negative contributor amount', e);
    }

    // Test 4: refundProposalFee Sanity Check (Negative fee)
    console.log('Test 4: refundProposalFee with negative fee');
    const proposalWithNegFee = {
        fee: -10,
        creator: 'creator'
    };
    try {
        await dao.refundProposalFee(proposalWithNegFee, Date.now());
        console.log('✅ Passed: Handled negative fee correctly');
    } catch (e) {
        console.error('❌ Failed: Threw error on negative proposal fee', e);
    }

    // Test 5: disburseFundRequest Sanity Check (Negative amount)
    console.log('Test 5: disburseFundRequest with negative amount');
    try {
        await dao.disburseFundRequest('beneficiary', -100, Date.now());
        console.log('✅ Passed: Handled negative disbursement correctly');
    } catch (e) {
        console.error('❌ Failed: Threw error on negative disbursement', e);
    }

    console.log('All tests completed.');
}

runTests().catch(err => {
    console.error('Test suite crashed:', err);
    process.exit(1);
});
