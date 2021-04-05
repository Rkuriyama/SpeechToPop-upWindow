//// load word list
var GWL = {
    "test": "description",
    "ピーク": "壁から体を出す行為。",
    "ガジェット": "各オペレータに用意されている道具。"
}

SpeechRecognition = webkitSpeechRecognition || SpeechRecognition;

var recogObj = {
    debug: false,
    state: {
        finalTranscript: 'hi',
        interimTranscript: '',
        list: ['test']
    },
    control: new SpeechRecognition()
}

recogObj.control.lang = 'ja-JP';
recogObj.control.interimResults = true;
recogObj.control.continuous = true;
recogObj.control.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
        let transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
            recogObj.state.finalTranscript += transcript;
            // キーワード検索して、合致したらキューに追加。pop up表示に投げる
            recogObj.state.list = searchWord(recogObj.state.finalTranscript, GWL);
            recogObj.state.finalTranscript = '';
            console.log(recogObj.state.list);
        } else {
            recogObj.state.interimTranscript = transcript;
        }
        console.log(transcript);
    }
}

//////////////// 単語検索
function searchWord (script, wordList){
    let result = [];
    for(let key in wordList){
        let idx =  script.indexOf(key);
        if(idx >= 0){
            result.push(key);
        }
        console.log()
    }
    result.sort((a, b) => a.index - b.index);
    return result;
}

///////////////// ポップアップ
Vue.component('pop-up', {
    props:['title','description'],
    template: `
        <div id="background">
            <div id="pop_up_window">
                <div id="pop_up_title">{{title}}</div>
                <div id="pop_up_description">{{description}}</div>
            </div>
        </div>
    `
});

///////////////// リスト
Vue.component('wordlist',{
    props:['title', 'description','state'],
    template: `
            <button v-on:click="set">{{title}}</button>
    `,
    methods: {
        set: function(event){
            this.state.list = [this.title];
            console.log(recogObj.state.list)
        }
    }
});


////////////////// 本体
var app = new Vue({
    el: '#app',
    data: {
        sharedObj: recogObj,
        state: recogObj.state,
        Words: GWL
    },
    methods: {
        start: function(event){
            this.sharedObj.control.start();
        },
        stop: function(event){
            this.sharedObj.control.stop();
        }
    },
    computed: {
        title: function(){
            return this.state.list[0]
        },    
        description: function(){
          return GWL[ this.state.list[0] ];
      }
    }
});
